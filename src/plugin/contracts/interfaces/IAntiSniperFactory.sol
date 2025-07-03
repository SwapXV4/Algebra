// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;
pragma abicoder v2;

import '@cryptoalgebra/integral-core/contracts/interfaces/plugin/IAlgebraPluginFactory.sol';

import './IAntiSniper.sol';
import './IBasePluginV1Factory.sol';
import '../base/AlgebraFeeConfiguration.sol';

/// @title The interface for the AntiSniperFactory
/// @notice This contract creates Algebra default plugins for Algebra liquidity pools
interface IAntiSniperFactory is IBasePluginV1Factory {
  /// @notice Emitted when auxiliary fee configuration is updated
  /// @param _newAuxFeeData The new auxiliary fee configuration
  event AuxFee(IAntiSniper.AuxFeeData _newAuxFeeData);

  /// @notice Current default auxiliary fee configuration
  /// This value is set by default in new plugins
  function defaultAuxFeeData() external view returns (address feeReceiver, uint24 period, uint24 startingFee, bool disabledPriorStart);

  /// @notice Update the default auxiliary fee configuration
  /// @dev Only callable by authorized address
  /// @param _newValue New auxiliary fee configuration
  function setDefaultAuxFeeData(IAntiSniper.AuxFeeData memory _newValue) external;

  /// @notice Returns the anti-sniper plugin implementation
  function ANTISNIPER_IMPL() external view returns (address);
}
