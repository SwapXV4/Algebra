// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.20;

import '@cryptoalgebra/integral-core/contracts/base/common/Timestamp.sol';
import '@cryptoalgebra/integral-core/contracts/libraries/Plugins.sol';

import '@cryptoalgebra/integral-core/contracts/interfaces/IAlgebraFactory.sol';
import '@cryptoalgebra/integral-core/contracts/interfaces/plugin/IAlgebraPlugin.sol';
import '@cryptoalgebra/integral-core/contracts/interfaces/pool/IAlgebraPoolState.sol';
import '@cryptoalgebra/integral-core/contracts/interfaces/IAlgebraPool.sol';

import './interfaces/IAntiSniper.sol';
import './interfaces/IBasePluginV1Factory.sol';
import './interfaces/IAlgebraVirtualPool.sol';

import './libraries/VolatilityOracle.sol';
import './libraries/AdaptiveFee.sol';
import './types/AlgebraFeeConfigurationU144.sol';

import {SafeTransfer} from './libraries/SafeTransfer.sol';

/// @title Algebra Integral 1.0 default plugin
/// @notice This contract stores timepoints and calculates adaptive fee and statistical averages
contract AntiSniper is IAntiSniper, Timestamp, IAlgebraPlugin {
  using Plugins for uint8;
  using AlgebraFeeConfigurationU144Lib for AlgebraFeeConfiguration;

  uint256 internal constant UINT16_MODULO = 65536;
  using VolatilityOracle for VolatilityOracle.Timepoint[UINT16_MODULO];

  /// @dev The role can be granted in AlgebraFactory
  bytes32 public constant ALGEBRA_BASE_PLUGIN_MANAGER = keccak256('ALGEBRA_BASE_PLUGIN_MANAGER');

  /// @inheritdoc IAlgebraPlugin
  uint8 public constant override defaultPluginConfig =
    uint8(Plugins.AFTER_INIT_FLAG | Plugins.BEFORE_SWAP_FLAG | Plugins.DYNAMIC_FEE | Plugins.BEFORE_POSITION_MODIFY_FLAG);
  uint24 constant MAX_FEE = (Constants.FEE_DENOMINATOR * 9) / 10;
  uint256 constant MIN_SNIPE_PERIOD = 5 minutes;
  uint256 constant MAX_SNIPE_PERIOD = 1 days;

  /// @inheritdoc IFarmingPlugin
  address public override pool;
  address private factory;
  address private pluginFactory;

  /// @inheritdoc IVolatilityOracle
  VolatilityOracle.Timepoint[UINT16_MODULO] public override timepoints;

  /// @inheritdoc IVolatilityOracle
  uint16 public override timepointIndex;

  /// @inheritdoc IVolatilityOracle
  uint32 public override lastTimepointTimestamp;

  /// @inheritdoc IVolatilityOracle
  bool public override isInitialized;

  /// @dev AlgebraFeeConfiguration struct packed in uint144
  AlgebraFeeConfigurationU144 private _feeConfig;

  /// @dev AuxFeeData struct auxiliary fee data
  AuxFeeData private _auxFeeData;

  /// @dev Trading start timestamp
  uint64 private _startTimestamp;

  /// @inheritdoc IAntiSniper
  mapping(address => bool) public override isExempted;

  /// @inheritdoc IFarmingPlugin
  address public override incentive;

  /// @dev the address which connected the last incentive. Needed so that he can disconnect it
  address private _lastIncentiveOwner;

  /// @inheritdoc IAntiSniper
  bool public isConstructed;

  modifier onlyPool() {
    _checkIfFromPool();
    _;
  }

  /// @inheritdoc IAntiSniper
  function construct(address _pool, address _factory, address _pluginFactory) public {
    require(!isConstructed, 'Constructed');
    (factory, pool, pluginFactory) = (_factory, _pool, _pluginFactory);
    isConstructed = true;

    emit Constructed(_pool, _factory, _pluginFactory);
  }

  /// @inheritdoc IDynamicFeeManager
  function feeConfig()
    external
    view
    override
    returns (uint16 alpha1, uint16 alpha2, uint32 beta1, uint32 beta2, uint16 gamma1, uint16 gamma2, uint16 baseFee)
  {
    (alpha1, alpha2) = (_feeConfig.alpha1(), _feeConfig.alpha2());
    (beta1, beta2) = (_feeConfig.beta1(), _feeConfig.beta2());
    (gamma1, gamma2) = (_feeConfig.gamma1(), _feeConfig.gamma2());
    baseFee = _feeConfig.baseFee();
  }

  /// @inheritdoc IAntiSniper
  function auxFeeConfig()
    external
    view
    override
    returns (uint256 startTimestamp_, address feeReceiver_, uint24 period_, uint24 startingFee_, uint24 currentAuxFee_, bool disabledPriorStart_)
  {
    AuxFeeData memory d = _auxFeeData;
    return (_startTimestamp, d.feeReceiver, d.period, d.startingFee, _getCurrentAuxFee(d), d.disabledPriorStart);
  }

  function _checkIfFromPool() internal view {
    require(msg.sender == pool, 'Only pool can call this');
  }

  function _getPoolState() internal view returns (uint160 price, int24 tick, uint16 fee, uint8 pluginConfig) {
    (price, tick, fee, pluginConfig, , ) = IAlgebraPoolState(pool).globalState();
  }

  function _getPluginInPool() internal view returns (address plugin) {
    return IAlgebraPool(pool).plugin();
  }

  /// @inheritdoc IAntiSniper
  function initialize() external override {
    require(!isInitialized, 'Already initialized');
    require(isConstructed, 'Not constructed');
    require(_getPluginInPool() == address(this), 'Plugin not attached');
    (uint160 price, int24 tick, , ) = _getPoolState();
    require(price != 0, 'Pool is not initialized');

    uint32 time = _blockTimestamp();
    timepoints.initialize(time, tick);
    lastTimepointTimestamp = time;
    isInitialized = true;

    _updatePluginConfigInPool();
  }

  // ###### Volatility and TWAP oracle ######

  /// @inheritdoc IVolatilityOracle
  function getSingleTimepoint(uint32 secondsAgo) external view override returns (int56 tickCumulative, uint88 volatilityCumulative) {
    // `volatilityCumulative` values for timestamps after the last timepoint _should not_ be compared: they may differ due to interpolation errors
    (, int24 tick, , ) = _getPoolState();
    uint16 lastTimepointIndex = timepointIndex;
    uint16 oldestIndex = timepoints.getOldestIndex(lastTimepointIndex);
    VolatilityOracle.Timepoint memory result = timepoints.getSingleTimepoint(_blockTimestamp(), secondsAgo, tick, lastTimepointIndex, oldestIndex);
    (tickCumulative, volatilityCumulative) = (result.tickCumulative, result.volatilityCumulative);
  }

  /// @inheritdoc IVolatilityOracle
  function getTimepoints(
    uint32[] memory secondsAgos
  ) external view override returns (int56[] memory tickCumulatives, uint88[] memory volatilityCumulatives) {
    // `volatilityCumulative` values for timestamps after the last timepoint _should not_ be compared: they may differ due to interpolation errors
    (, int24 tick, , ) = _getPoolState();
    return timepoints.getTimepoints(_blockTimestamp(), secondsAgos, tick, timepointIndex);
  }

  /// @inheritdoc IVolatilityOracle
  function prepayTimepointsStorageSlots(uint16 startIndex, uint16 amount) external override {
    require(!timepoints[startIndex].initialized); // if not initialized, then all subsequent ones too
    require(amount > 0 && type(uint16).max - startIndex >= amount);

    unchecked {
      for (uint256 i = startIndex; i < startIndex + amount; ++i) {
        timepoints[i].blockTimestamp = 1; // will be overwritten
      }
    }
  }

  // ###### Fee manager ######

  /// @inheritdoc IDynamicFeeManager
  function changeFeeConfiguration(AlgebraFeeConfiguration calldata _config) external override {
    require(msg.sender == pluginFactory || IAlgebraFactory(factory).hasRoleOrOwner(ALGEBRA_BASE_PLUGIN_MANAGER, msg.sender));
    AdaptiveFee.validateFeeConfiguration(_config);

    _feeConfig = _config.pack(); // pack struct to uint144 and write in storage
    if (msg.sender != pluginFactory && (_startTimestamp == 0 || block.timestamp < _startTimestamp)) {
      IAlgebraPool(pool).setFee(_config.baseFee);
    }

    emit FeeConfiguration(_config);
  }

  /// @inheritdoc IAntiSniper
  function setAuxFeeData(IAntiSniper.AuxFeeData memory _newValue) external override {
    require(msg.sender == pluginFactory || IAlgebraFactory(factory).hasRoleOrOwner(ALGEBRA_BASE_PLUGIN_MANAGER, msg.sender));
    require(_newValue.feeReceiver != address(0));

    if (_startTimestamp == 0 || _startTimestamp > block.timestamp) {
      require(_newValue.startingFee <= MAX_FEE);
      require(_newValue.period >= MIN_SNIPE_PERIOD && _newValue.period <= MAX_SNIPE_PERIOD);

      _auxFeeData = _newValue;
    } else {
      _auxFeeData.feeReceiver = _newValue.feeReceiver;
    }

    emit AuxFee(_auxFeeData);
  }

  /// @inheritdoc IAntiSniper
  function exempt(address[] calldata _addrs, bool _exempt) external {
    require(IAlgebraFactory(factory).hasRoleOrOwner(ALGEBRA_BASE_PLUGIN_MANAGER, msg.sender));
    for (uint256 i; i < _addrs.length; i++) {
      isExempted[_addrs[i]] = _exempt;
    }
    emit Exempt(_addrs, _exempt);
  }

  /// @inheritdoc IAntiSniper
  function setStartTimestamp(uint64 _newStartTimestamp) external {
    require(IAlgebraFactory(factory).hasRoleOrOwner(ALGEBRA_BASE_PLUGIN_MANAGER, msg.sender));
    require(_newStartTimestamp > block.timestamp, 'In past');
    if (_startTimestamp != 0) require(block.timestamp < _startTimestamp, 'Trading started');
    _startTimestamp = _newStartTimestamp;

    emit StartTimestamp(_newStartTimestamp);
  }

  /// @inheritdoc IAlgebraDynamicFeePlugin
  function getCurrentFee() external view override returns (uint16 fee) {
    uint16 lastIndex = timepointIndex;
    AlgebraFeeConfigurationU144 feeConfig_ = _feeConfig;
    if (feeConfig_.alpha1() | feeConfig_.alpha2() == 0) return feeConfig_.baseFee();

    uint16 oldestIndex = timepoints.getOldestIndex(lastIndex);
    (, int24 tick, , ) = _getPoolState();

    uint88 volatilityAverage = timepoints.getAverageVolatility(_blockTimestamp(), tick, lastIndex, oldestIndex);
    return AdaptiveFee.getFee(volatilityAverage, feeConfig_);
  }

  function _getFeeAtLastTimepoint(
    uint16 lastTimepointIndex,
    uint16 oldestTimepointIndex,
    int24 currentTick,
    AlgebraFeeConfigurationU144 feeConfig_
  ) internal view returns (uint16 fee) {
    if (feeConfig_.alpha1() | feeConfig_.alpha2() == 0) return feeConfig_.baseFee();

    uint88 volatilityAverage = timepoints.getAverageVolatility(_blockTimestamp(), currentTick, lastTimepointIndex, oldestTimepointIndex);
    return AdaptiveFee.getFee(volatilityAverage, feeConfig_);
  }

  // ###### Farming plugin ######

  /// @inheritdoc IFarmingPlugin
  function setIncentive(address newIncentive) external override {
    bool toConnect = newIncentive != address(0);
    bool accessAllowed;
    if (toConnect) {
      accessAllowed = msg.sender == IBasePluginV1Factory(pluginFactory).farmingAddress();
    } else {
      // we allow the one who connected the incentive to disconnect it,
      // even if he no longer has the rights to connect incentives
      if (_lastIncentiveOwner != address(0)) accessAllowed = msg.sender == _lastIncentiveOwner;
      if (!accessAllowed) accessAllowed = msg.sender == IBasePluginV1Factory(pluginFactory).farmingAddress();
    }
    require(accessAllowed, 'Not allowed to set incentive');

    bool isPluginConnected = _getPluginInPool() == address(this);
    if (toConnect) require(isPluginConnected, 'Plugin not attached');

    address currentIncentive = incentive;
    require(currentIncentive != newIncentive, 'Already active');
    if (toConnect) require(currentIncentive == address(0), 'Has active incentive');

    incentive = newIncentive;
    emit Incentive(newIncentive);

    if (toConnect) {
      _lastIncentiveOwner = msg.sender; // write creator of this incentive
    } else {
      _lastIncentiveOwner = address(0);
    }

    if (isPluginConnected) {
      _updatePluginConfigInPool();
    }
  }

  /// @inheritdoc IFarmingPlugin
  function isIncentiveConnected(address targetIncentive) external view override returns (bool) {
    if (incentive != targetIncentive) return false;
    if (_getPluginInPool() != address(this)) return false;
    (, , , uint8 pluginConfig) = _getPoolState();
    if (!pluginConfig.hasFlag(Plugins.AFTER_SWAP_FLAG)) return false;

    return true;
  }

  // ###### HOOKS ######

  function beforeInitialize(address, uint160) external override onlyPool returns (bytes4) {
    _updatePluginConfigInPool();
    return IAlgebraPlugin.beforeInitialize.selector;
  }

  function afterInitialize(address, uint160, int24 tick) external override onlyPool returns (bytes4) {
    uint32 _timestamp = _blockTimestamp();
    timepoints.initialize(_timestamp, tick);

    lastTimepointTimestamp = _timestamp;
    isInitialized = true;

    IAlgebraPool(pool).setFee(_feeConfig.baseFee());
    return IAlgebraPlugin.afterInitialize.selector;
  }

  function beforeModifyPosition(address caller, address, int24, int24, int128, bytes calldata) external view override onlyPool returns (bytes4) {
    require(IBasePluginV1Factory(pluginFactory).modifyLiquidityEntryPointsStatuses(caller) == true, 'only modifyLiquidityEntrypoint');
    return IAlgebraPlugin.beforeModifyPosition.selector;
  }

  /// @dev unused
  function afterModifyPosition(address, address, int24, int24, int128, uint256, uint256, bytes calldata) external override onlyPool returns (bytes4) {
    _updatePluginConfigInPool(); // should not be called, reset config
    return IAlgebraPlugin.afterModifyPosition.selector;
  }

  function beforeSwap(
    address sender,
    address,
    bool zeroToOne,
    int256 amount,
    uint160,
    bool,
    bytes calldata
  ) external override onlyPool returns (bytes4) {
    _writeTimepointAndUpdateFee();

    if (!isExempted[sender]) {
      AuxFeeData memory d = _auxFeeData;
      require(!d.disabledPriorStart || (block.timestamp >= _startTimestamp && _startTimestamp > 0), 'Trading disabled');
      uint24 auxFee = _getCurrentAuxFee(d);

      if (auxFee > 0) {
        (, , uint16 lastFee, , , ) = IAlgebraPool(pool).globalState();
        uint256 amountIn = uint256(amount >= 0 ? amount : -amount);
        uint256 fee = _calculatePluginFee(amountIn, lastFee, auxFee);

        if (fee > 0) {
          address token = (amount >= 0 ? zeroToOne : !zeroToOne) ? IAlgebraPool(pool).token0() : IAlgebraPool(pool).token1();
          _transferFrom({token: token, from: tx.origin, to: d.feeReceiver, amount: fee});
        }
      }
    }

    return IAlgebraPlugin.beforeSwap.selector;
  }

  function afterSwap(address, address, bool zeroToOne, int256, uint160, int256, int256, bytes calldata) external override onlyPool returns (bytes4) {
    address _incentive = incentive;
    if (_incentive != address(0)) {
      (, int24 tick, , ) = _getPoolState();
      IAlgebraVirtualPool(_incentive).crossTo(tick, zeroToOne);
    } else {
      _updatePluginConfigInPool(); // should not be called, reset config
    }

    return IAlgebraPlugin.afterSwap.selector;
  }

  /// @dev unused
  function beforeFlash(address, address, uint256, uint256, bytes calldata) external override onlyPool returns (bytes4) {
    _updatePluginConfigInPool(); // should not be called, reset config
    return IAlgebraPlugin.beforeFlash.selector;
  }

  /// @dev unused
  function afterFlash(address, address, uint256, uint256, uint256, uint256, bytes calldata) external override onlyPool returns (bytes4) {
    _updatePluginConfigInPool(); // should not be called, reset config
    return IAlgebraPlugin.afterFlash.selector;
  }

  function _updatePluginConfigInPool() internal {
    uint8 newPluginConfig = defaultPluginConfig;
    if (incentive != address(0)) {
      newPluginConfig |= uint8(Plugins.AFTER_SWAP_FLAG);
    }

    (, , , uint8 currentPluginConfig) = _getPoolState();
    if (currentPluginConfig != newPluginConfig) {
      IAlgebraPool(pool).setPluginConfig(newPluginConfig);
    }
  }

  function _writeTimepointAndUpdateFee() internal {
    // single SLOAD
    uint16 _lastIndex = timepointIndex;
    uint32 _lastTimepointTimestamp = lastTimepointTimestamp;
    AlgebraFeeConfigurationU144 feeConfig_ = _feeConfig; // struct packed in uint144
    bool _isInitialized = isInitialized;
    require(_isInitialized, 'Not initialized');

    uint32 currentTimestamp = _blockTimestamp();

    if (_lastTimepointTimestamp == currentTimestamp) return;

    (, int24 tick, uint16 fee, ) = _getPoolState();
    (uint16 newLastIndex, uint16 newOldestIndex) = timepoints.write(_lastIndex, currentTimestamp, tick);

    timepointIndex = newLastIndex;
    lastTimepointTimestamp = currentTimestamp;

    uint16 newFee = _getFeeAtLastTimepoint(newLastIndex, newOldestIndex, tick, feeConfig_);
    bool isSnipePeriodFinished = _startTimestamp > 0 && block.timestamp >= _startTimestamp + _auxFeeData.period;

    if (newFee != fee && isSnipePeriodFinished) {
      IAlgebraPool(pool).setFee(newFee);
    }
  }

  function _transferFrom(address token, address from, address to, uint256 amount) internal virtual {
    SafeTransfer.safeTransferFrom(token, from, to, amount);
  }

  function _getCurrentAuxFee(AuxFeeData memory d) internal view returns (uint24) {
    if (_startTimestamp == 0 || block.timestamp < _startTimestamp) return d.startingFee;
    if (block.timestamp >= _startTimestamp + d.period) return 0;

    uint256 elapsed = block.timestamp - _startTimestamp;
    uint256 feeDecay = (uint256(d.startingFee) * elapsed) / d.period;
    return uint24(uint256(d.startingFee) - feeDecay);
  }

  function _calculatePluginFee(uint256 amountIn, uint16 lastFee, uint24 auxFee) internal pure returns (uint256) {
    uint256 poolFee = (amountIn * lastFee) / Constants.FEE_DENOMINATOR;
    uint256 netFromPool = amountIn - poolFee;
    uint256 targetFeeRate = uint256(lastFee) + uint256(auxFee);
    uint256 denominator = Constants.FEE_DENOMINATOR - targetFeeRate;
    if (denominator == 0) return 0;
    uint256 totalCost = (netFromPool * Constants.FEE_DENOMINATOR) / denominator;
    uint256 pluginFee = totalCost - netFromPool - poolFee;
    return pluginFee;
  }
}
