// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.20;

import './AlgebraAntiSniperPluginV1.sol';
import './interfaces/IAntiSniperPluginV1Factory.sol';
import '@cryptoalgebra/integral-core/contracts/libraries/Constants.sol';

/// @title Algebra Integral 1.0 default plugin factory
/// @notice This contract creates Algebra default plugins for Algebra liquidity pools
contract AntiSniperPluginFactory is IAntiSniperPluginV1Factory {
  uint24 constant MAX_FEE = 0.9e6;
  uint256 constant MIN_SNIPE_PERIOD = 5 minutes;
  uint256 constant MAX_SNIPE_PERIOD = 1 days;

  /// @inheritdoc IAntiSniperPluginV1Factory
  bytes32 public constant override ALGEBRA_BASE_PLUGIN_FACTORY_ADMINISTRATOR = keccak256('ALGEBRA_BASE_PLUGIN_FACTORY_ADMINISTRATOR');

  /// @inheritdoc IAntiSniperPluginV1Factory
  address public immutable override algebraFactory;

  /// @inheritdoc IAntiSniperPluginV1Factory
  IAlgebraAntiSniperPluginV1.AuxFeeData public defaultAuxFeeData;

  /// @inheritdoc IAntiSniperPluginV1Factory
  address public override farmingAddress;

  /// @inheritdoc IAntiSniperPluginV1Factory
  mapping(address poolAddress => address pluginAddress) public override pluginByPool;

  /// @inheritdoc IAntiSniperPluginV1Factory
  mapping(address modifyLiqudityEntryPoint => bool isEnabled) public override modifyLiquidityEntryPointsStatuses;

  modifier onlyAdministrator() {
    require(IAlgebraFactory(algebraFactory).hasRoleOrOwner(ALGEBRA_BASE_PLUGIN_FACTORY_ADMINISTRATOR, msg.sender), 'Only administrator');
    _;
  }

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
    require(msg.sender == algebraFactory);
    return _createPlugin(pool);
  }

  /// @inheritdoc IAntiSniperPluginV1Factory
  function createPluginForExistingPool(address token0, address token1) external override returns (address) {
    IAlgebraFactory factory = IAlgebraFactory(algebraFactory);
    require(factory.hasRoleOrOwner(factory.POOLS_ADMINISTRATOR_ROLE(), msg.sender));

    address pool = factory.poolByPair(token0, token1);
    require(pool != address(0), 'Pool not exist');

    return _createPlugin(pool);
  }

  function _createPlugin(address pool) internal returns (address) {
    require(pluginByPool[pool] == address(0), 'Already created');
    AlgebraAntiSniperPluginV1 plugin = new AlgebraAntiSniperPluginV1(pool, algebraFactory, address(this), defaultAuxFeeData);
    pluginByPool[pool] = address(plugin);
    return address(plugin);
  }

  /// @inheritdoc IAntiSniperPluginV1Factory
  function setFarmingAddress(address newFarmingAddress) external override onlyAdministrator {
    require(farmingAddress != newFarmingAddress);
    farmingAddress = newFarmingAddress;
    emit FarmingAddress(newFarmingAddress);
  }

  /// @inheritdoc IAntiSniperPluginV1Factory
  function addModifyLiquidityEntrypoint(address entrypoint) external override onlyAdministrator {
    require(modifyLiquidityEntryPointsStatuses[entrypoint] == false);
    modifyLiquidityEntryPointsStatuses[entrypoint] = true;
    emit AddModifyLiquidityEntrypoint(entrypoint);
  }

  /// @inheritdoc IAntiSniperPluginV1Factory
  function removeModifyLiquidityEntrypoint(address entrypoint) external override onlyAdministrator {
    require(modifyLiquidityEntryPointsStatuses[entrypoint] == true);
    modifyLiquidityEntryPointsStatuses[entrypoint] = false;
    emit RemoveModifyLiquidityEntrypoint(entrypoint);
  }

  /// @inheritdoc IAntiSniperPluginV1Factory
  function setDefaultAuxFeeData(IAlgebraAntiSniperPluginV1.AuxFeeData memory _newValue) external override onlyAdministrator {
    require(_newValue.feeReceiver != address(0));
    require(_newValue.startingFee <= MAX_FEE);
    require(_newValue.period >= MIN_SNIPE_PERIOD && _newValue.period <= MAX_SNIPE_PERIOD);

    defaultAuxFeeData = _newValue;
    emit AuxFee(_newValue);
  }
}
