// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.20;

import '../base/AlgebraFeeConfiguration.sol';
import '../libraries/AdaptiveFee.sol';

import './MockTimeAntiSniper.sol';

import '../interfaces/IAntiSniperFactory.sol';
import '../interfaces/IAntiSniper.sol';
import '@openzeppelin/contracts/proxy/Clones.sol';

import '@cryptoalgebra/integral-core/contracts/interfaces/plugin/IAlgebraPluginFactory.sol';

contract MockTimeAntiSniperFactory is IAntiSniperFactory {
  uint24 constant MAX_FEE = 0.9e6;
  uint256 constant MIN_SNIPE_PERIOD = 5 minutes;
  uint256 constant MAX_SNIPE_PERIOD = 1 days;

  /// @inheritdoc IBasePluginV1Factory
  bytes32 public constant override ALGEBRA_BASE_PLUGIN_FACTORY_ADMINISTRATOR = keccak256('ALGEBRA_BASE_PLUGIN_FACTORY_ADMINISTRATOR');

  /// @dev initial minimum base fee
  uint16 internal constant INITIAL_MIN_FEE = 1e4; // 1%

  address public immutable override algebraFactory;

  /// @inheritdoc IAntiSniperFactory
  IAntiSniper.AuxFeeData public defaultAuxFeeData;

  address public immutable ANTISNIPER_IMPL;

  /// @inheritdoc IBasePluginV1Factory
  AlgebraFeeConfiguration public override defaultFeeConfiguration; // values of constants for sigmoids in fee calculation formula

  /// @inheritdoc IBasePluginV1Factory
  mapping(address => address) public override pluginByPool;

  /// @inheritdoc IBasePluginV1Factory
  address public override farmingAddress;

  function _initialDefaultAuxFeeData() internal pure returns (IAntiSniper.AuxFeeData memory auxFeeData_) {
    auxFeeData_ = IAntiSniper.AuxFeeData({period: 30 minutes, startingFee: 0.49e6, feeReceiver: address(0), disabledPriorStart: true});
  }

  /// @notice Returns default initial fee configuration
  function _initialFeeConfiguration() internal pure returns (AlgebraFeeConfiguration memory) {
    return
      AlgebraFeeConfiguration({
        alpha1: 0, // max value of the first sigmoid in hundredths of a bip, i.e. 1e-6
        alpha2: 0, // max value of the second sigmoid in hundredths of a bip, i.e. 1e-6
        beta1: 360, // shift along the x-axis (volatility) for the first sigmoid
        beta2: 60000, // shift along the x-axis (volatility) for the second sigmoid
        gamma1: 59, // horizontal stretch factor for the first sigmoid
        gamma2: 8500, // horizontal stretch factor for the second sigmoid
        baseFee: INITIAL_MIN_FEE // in hundredths of a bip, i.e. 1e-6
      });
  }

  constructor(address _algebraFactory, address _feeReceiver) {
    ANTISNIPER_IMPL = address(new MockTimeAntiSniper());
    algebraFactory = _algebraFactory;
    defaultFeeConfiguration = _initialFeeConfiguration();
    defaultAuxFeeData = _initialDefaultAuxFeeData();
    defaultAuxFeeData.feeReceiver = _feeReceiver;
    emit DefaultFeeConfiguration(defaultFeeConfiguration);
  }

  /// @inheritdoc IAlgebraPluginFactory
  function createPlugin(address pool, address, address) external override returns (address) {
    return _createPlugin(pool);
  }

  function createPluginForExistingPool(address token0, address token1) external override returns (address) {
    IAlgebraFactory factory = IAlgebraFactory(algebraFactory);
    require(factory.hasRoleOrOwner(factory.POOLS_ADMINISTRATOR_ROLE(), msg.sender));

    address pool = factory.poolByPair(token0, token1);
    require(pool != address(0), 'Pool not exist');

    return _createPlugin(pool);
  }

  function setPluginForPool(address pool, address plugin) external {
    pluginByPool[pool] = plugin;
  }

  function _createPlugin(address pool) internal returns (address) {
    require(pluginByPool[pool] == address(0), 'Already created');
    MockTimeAntiSniper volatilityOracle = MockTimeAntiSniper(Clones.clone(ANTISNIPER_IMPL));
    volatilityOracle.construct(pool, algebraFactory, address(this));
    volatilityOracle.setAuxFeeData(defaultAuxFeeData);
    volatilityOracle.changeFeeConfiguration(defaultFeeConfiguration);
    volatilityOracle.initializeTime();
    pluginByPool[pool] = address(volatilityOracle);
    return address(volatilityOracle);
  }

  /// @inheritdoc IBasePluginV1Factory
  function setDefaultFeeConfiguration(AlgebraFeeConfiguration calldata newConfig) external override {
    AdaptiveFee.validateFeeConfiguration(newConfig);
    defaultFeeConfiguration = newConfig;
    emit DefaultFeeConfiguration(newConfig);
  }

  /// @inheritdoc IBasePluginV1Factory
  function setFarmingAddress(address newFarmingAddress) external override {
    require(farmingAddress != newFarmingAddress);
    farmingAddress = newFarmingAddress;
    emit FarmingAddress(newFarmingAddress);
  }

  mapping(address modifyLiqudityEntryPoint => bool isEnabled) public override modifyLiquidityEntryPointsStatuses;

  function addModifyLiquidityEntrypoint(address entrypoint) external override {
    require(modifyLiquidityEntryPointsStatuses[entrypoint] == false);
    modifyLiquidityEntryPointsStatuses[entrypoint] = true;
    emit AddModifyLiquidityEntrypoint(entrypoint);
  }

  function removeModifyLiquidityEntrypoint(address entrypoint) external override {
    require(modifyLiquidityEntryPointsStatuses[entrypoint] == true);
    modifyLiquidityEntryPointsStatuses[entrypoint] = false;
    emit RemoveModifyLiquidityEntrypoint(entrypoint);
  }

  /// @inheritdoc IAntiSniperFactory
  function setDefaultAuxFeeData(IAntiSniper.AuxFeeData memory _newValue) external override {
    require(_newValue.feeReceiver != address(0));
    require(_newValue.startingFee <= MAX_FEE);
    require(_newValue.period >= MIN_SNIPE_PERIOD && _newValue.period <= MAX_SNIPE_PERIOD);

    defaultAuxFeeData = _newValue;
    emit AuxFee(_newValue);
  }
}
