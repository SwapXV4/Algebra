// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.20;

import '@cryptoalgebra/integral-core/contracts/base/common/Timestamp.sol';
import '@cryptoalgebra/integral-core/contracts/libraries/Plugins.sol';

import '@cryptoalgebra/integral-core/contracts/interfaces/IAlgebraFactory.sol';
import '@cryptoalgebra/integral-core/contracts/interfaces/plugin/IAlgebraPlugin.sol';
import '@cryptoalgebra/integral-core/contracts/interfaces/pool/IAlgebraPoolState.sol';
import '@cryptoalgebra/integral-core/contracts/interfaces/IAlgebraPool.sol';

import './interfaces/IAlgebraAntiSniperPluginV1.sol';
import './interfaces/IBasePluginV1Factory.sol';
import './interfaces/IAlgebraVirtualPool.sol';

import {SafeTransfer} from './libraries/SafeTransfer.sol';
import '@cryptoalgebra/integral-core/contracts/libraries/Constants.sol';

/// @title Algebra Integral 1.0 default plugin
/// @notice This contract stores timepoints and calculates adaptive fee and statistical averages
contract AlgebraAntiSniperPluginV1 is IAlgebraAntiSniperPluginV1, Timestamp, IAlgebraPlugin {
  using Plugins for uint8;

  /// @dev The role can be granted in AlgebraFactory
  bytes32 public constant ALGEBRA_BASE_PLUGIN_MANAGER = keccak256('ALGEBRA_BASE_PLUGIN_MANAGER');

  /// @inheritdoc IAlgebraPlugin
  uint8 public constant override defaultPluginConfig =
    uint8(Plugins.BEFORE_SWAP_FLAG | Plugins.AFTER_SWAP_FLAG | Plugins.BEFORE_POSITION_MODIFY_FLAG);
  uint24 constant MAX_FEE = (Constants.FEE_DENOMINATOR * 9) / 10;
  uint256 constant MIN_SNIPE_PERIOD = 5 minutes;
  uint256 constant MAX_SNIPE_PERIOD = 1 days;

  /// @inheritdoc IFarmingPlugin
  address public immutable override pool;
  address private immutable factory;
  address private immutable pluginFactory;

  /// @inheritdoc IAlgebraAntiSniperPluginV1
  bool public override isInitialized;

  /// @inheritdoc IFarmingPlugin
  address public override incentive;

  /// @inheritdoc IAlgebraAntiSniperPluginV1
  mapping(address => bool) public override isExempted;

  /// @dev the address which connected the last incentive. Needed so that he can disconnect it
  address private _lastIncentiveOwner;

  /// @dev AuxFeeData struct auxiliary fee data
  AuxFeeData private _auxFeeData;

  /// @dev Trading start timestamp
  uint64 private _startTimestamp;

  modifier onlyPool() {
    _checkIfFromPool();
    _;
  }

  constructor(address _pool, address _factory, address _pluginFactory, AuxFeeData memory _feeData) {
    (factory, pool, pluginFactory) = (_factory, _pool, _pluginFactory);
    _auxFeeData = _feeData;
  }

  /// @inheritdoc IAlgebraAntiSniperPluginV1
  function feeConfig()
    external
    view
    override
    returns (uint256 startTimestamp_, address feeReceiver_, uint24 period_, uint24 startingFee_, uint24 currentAuxFee_, bool disabledPriorStart_)
  {
    AuxFeeData memory d = _auxFeeData;
    return (_startTimestamp, d.feeReceiver, d.period, d.startingFee, _getCurrentAuxFee(d), d.disabledPriorStart);
  }

  /// @inheritdoc IAlgebraAntiSniperPluginV1
  function initialize() external override {
    require(!isInitialized, 'Already initialized');
    require(_getPluginInPool() == address(this), 'Plugin not attached');
    (uint160 price, , , ) = _getPoolState();
    require(price != 0, 'Pool is not initialized');
    isInitialized = true;

    _updatePluginConfigInPool();
  }

  // ###### Anti Sniper ######

  /// @inheritdoc IAlgebraAntiSniperPluginV1
  function exempt(address[] calldata _addrs, bool _exempt) external {
    require(IAlgebraFactory(factory).hasRoleOrOwner(ALGEBRA_BASE_PLUGIN_MANAGER, msg.sender));
    for (uint256 i; i < _addrs.length; i++) {
      isExempted[_addrs[i]] = _exempt;
    }
    emit Exempt(_addrs, _exempt);
  }

  /// @inheritdoc IAlgebraAntiSniperPluginV1
  function setStartTimestamp(uint64 _newStartTimestamp) external {
    require(IAlgebraFactory(factory).hasRoleOrOwner(ALGEBRA_BASE_PLUGIN_MANAGER, msg.sender));
    require(_newStartTimestamp > block.timestamp, 'In past');
    if (_startTimestamp != 0) require(block.timestamp < _startTimestamp, 'Trading started');
    _startTimestamp = _newStartTimestamp;

    emit StartTimestamp(_newStartTimestamp);
  }

  /// @inheritdoc IAlgebraAntiSniperPluginV1
  function setAuxFeeData(IAlgebraAntiSniperPluginV1.AuxFeeData memory _newValue) external override {
    require(IAlgebraFactory(factory).hasRoleOrOwner(ALGEBRA_BASE_PLUGIN_MANAGER, msg.sender));
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

  /// @dev unused
  function afterInitialize(address, uint160, int24) external view override onlyPool returns (bytes4) {
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

  /// Helpers

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

  function _checkIfFromPool() internal view {
    require(msg.sender == pool, 'Only pool can call this');
  }

  function _getPoolState() internal view returns (uint160 price, int24 tick, uint16 fee, uint8 pluginConfig) {
    (price, tick, fee, pluginConfig, , ) = IAlgebraPoolState(pool).globalState();
  }

  function _getPluginInPool() internal view returns (address plugin) {
    return IAlgebraPool(pool).plugin();
  }

  function _calculatePluginFee(uint256 amountIn, uint16 lastFee, uint24 auxFee) internal pure returns (uint256) {
    uint256 poolFee = (amountIn * lastFee) / Constants.FEE_DENOMINATOR;
    uint256 netFromPool = amountIn - poolFee;
    uint256 targetFeeRate = uint256(lastFee) + uint256(auxFee);
    uint256 totalCost = (netFromPool * Constants.FEE_DENOMINATOR) / (Constants.FEE_DENOMINATOR - targetFeeRate);
    uint256 pluginFee = totalCost - netFromPool - poolFee;
    return pluginFee;
  }
}
