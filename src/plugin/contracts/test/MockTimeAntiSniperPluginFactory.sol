// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.20;

import '../base/AlgebraFeeConfiguration.sol';
import '../libraries/AdaptiveFee.sol';

import './MockTimeAlgebraAntiSniperPluginV1.sol';

import '../interfaces/IAntiSniperPluginV1Factory.sol';

import '@cryptoalgebra/integral-core/contracts/interfaces/plugin/IAlgebraPluginFactory.sol';

contract MockTimeAntiSniperPluginFactory is IAntiSniperPluginV1Factory {
  uint24 constant MAX_FEE = 0.9e6;
  uint256 constant MIN_SNIPE_PERIOD = 5 minutes;
  uint256 constant MAX_SNIPE_PERIOD = 1 days;

  /// @inheritdoc IAntiSniperPluginV1Factory
  bytes32 public constant override ALGEBRA_BASE_PLUGIN_FACTORY_ADMINISTRATOR = keccak256('ALGEBRA_BASE_PLUGIN_FACTORY_ADMINISTRATOR');

  address public immutable override algebraFactory;

  /// @inheritdoc IAntiSniperPluginV1Factory
  IAlgebraAntiSniperPluginV1.AuxFeeData public defaultAuxFeeData;

  /// @inheritdoc IAntiSniperPluginV1Factory
  mapping(address => address) public override pluginByPool;

  /// @inheritdoc IAntiSniperPluginV1Factory
  address public override farmingAddress;

  function _initialDefaultAuxFeeData() internal pure returns (IAlgebraAntiSniperPluginV1.AuxFeeData memory auxFeeData_) {
    auxFeeData_ = IAlgebraAntiSniperPluginV1.AuxFeeData({period: 30 minutes, startingFee: 0.49e6, feeReceiver: address(0), disabledPriorStart: true});
  }

  constructor(address _algebraFactory, address _feeReceiver) {
    algebraFactory = _algebraFactory;
    defaultAuxFeeData = _initialDefaultAuxFeeData();
    defaultAuxFeeData.feeReceiver = _feeReceiver;
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
    MockTimeAlgebraAntiSniperPluginV1 plugin = new MockTimeAlgebraAntiSniperPluginV1(pool, algebraFactory, address(this), defaultAuxFeeData);
    pluginByPool[pool] = address(plugin);
    return address(plugin);
  }

  /// @inheritdoc IAntiSniperPluginV1Factory
  function setDefaultAuxFeeData(IAlgebraAntiSniperPluginV1.AuxFeeData memory _newValue) external override {
    require(_newValue.feeReceiver != address(0));
    require(_newValue.startingFee <= MAX_FEE);
    require(_newValue.period >= MIN_SNIPE_PERIOD && _newValue.period <= MAX_SNIPE_PERIOD);

    defaultAuxFeeData = _newValue;
    emit AuxFee(_newValue);
  }

  /// @inheritdoc IAntiSniperPluginV1Factory
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
}
