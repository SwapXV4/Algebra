// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;
pragma abicoder v2;

import '@cryptoalgebra/integral-core/contracts/interfaces/plugin/IAlgebraPluginFactory.sol';

import '../base/AlgebraFeeConfiguration.sol';
import './IAlgebraAntiSniperPluginV1.sol';

/// @title The interface for the AntiSniperPluginFactory
/// @notice This contract creates Algebra default plugins for Algebra liquidity pools
interface IAntiSniperPluginV1Factory is IAlgebraPluginFactory {
  /// @notice Emitted when the farming address is changed
  /// @param newFarmingAddress The farming address after the address was changed
  event FarmingAddress(address newFarmingAddress);

  /// @notice Emitted when the entrypoint address is added
  /// @param entrypoint The entrypoint address that was added
  event AddModifyLiquidityEntrypoint(address entrypoint);

  /// @notice Emitted when the entrypoint address is removed
  /// @param entrypoint The entrypoint address that was removed
  event RemoveModifyLiquidityEntrypoint(address entrypoint);

  /// @notice Emitted when auxiliary fee configuration is updated
  /// @param _newAuxFeeData The new auxiliary fee configuration
  event AuxFee(IAlgebraAntiSniperPluginV1.AuxFeeData _newAuxFeeData);

  /// @notice The hash of 'ALGEBRA_BASE_PLUGIN_FACTORY_ADMINISTRATOR' used as role
  /// @dev allows to change settings of BasePluginV1Factory
  function ALGEBRA_BASE_PLUGIN_FACTORY_ADMINISTRATOR() external pure returns (bytes32);

  /// @notice Returns the address of AlgebraFactory
  /// @return The AlgebraFactory contract address
  function algebraFactory() external view returns (address);

  /// @notice Returns the status of entrypoint contract
  /// @param modifyLiqudityEntryPoint The address of entrypoint
  /// @return isEnabled Entrypoint status
  function modifyLiquidityEntryPointsStatuses(address modifyLiqudityEntryPoint) external view returns (bool isEnabled);

  /// @notice Current default auxiliary fee configuration
  /// This value is set by default in new plugins
  function defaultAuxFeeData() external view returns (address feeReceiver, uint24 period, uint24 startingFee, bool disabledPriorStart);

  /// @notice Returns current farming address
  /// @return The farming contract address
  function farmingAddress() external view returns (address);

  /// @notice Returns address of plugin created for given AlgebraPool
  /// @param pool The address of AlgebraPool
  /// @return The address of corresponding plugin
  function pluginByPool(address pool) external view returns (address);

  /// @notice Create plugin for already existing pool
  /// @param token0 The address of first token in pool
  /// @param token1 The address of second token in pool
  /// @return The address of created plugin
  function createPluginForExistingPool(address token0, address token1) external returns (address);

  /// @dev updates farmings manager address on the factory
  /// @param newFarmingAddress The new tokenomics contract address
  function setFarmingAddress(address newFarmingAddress) external;

  /// @notice Adds entrypoint contract
  /// @param entrypoint The address of entrypoint
  /// @dev Only admin can add entrypoint
  function addModifyLiquidityEntrypoint(address entrypoint) external;

  /// @notice Removes entrypoint contract
  /// @param entrypoint The address of entrypoint
  /// @dev Only admin can remove entrypoint
  function removeModifyLiquidityEntrypoint(address entrypoint) external;

  /// @notice Update the default auxiliary fee configuration
  /// @dev Only callable by authorized address
  /// @param _newValue New auxiliary fee configuration
  function setDefaultAuxFeeData(IAlgebraAntiSniperPluginV1.AuxFeeData memory _newValue) external;
}
