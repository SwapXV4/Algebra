// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;
pragma abicoder v2;

import './plugins/IVolatilityOracle.sol';
import './plugins/IDynamicFeeManager.sol';
import './plugins/IFarmingPlugin.sol';

/// @title The interface for the IAlgebraAntiSniperPluginV1
/// @notice This contract combines the standard implementations of the volatility oracle and the dynamic fee manager
/// @dev This contract stores timepoints and calculates adaptive fee and statistical averages
interface IAlgebraAntiSniperPluginV1 is IFarmingPlugin {
  // @notice Configuration data for auxiliary fee structure
  /// @dev Contains all parameters needed to configure anti-sniper fee mechanism
  struct AuxFeeData {
    /// @notice Address that receives the auxiliary fees
    address feeReceiver;
    /// @notice Duration in seconds for which the auxiliary fee is active
    uint24 period;
    /// @notice Initial fee percentage applied at the start of the period in the base of 1e6
    uint24 startingFee;
    /// @notice Whether the auxiliary fee is disabled before the start timestamp
    bool disabledPriorStart;
  }

  /// @notice Emitted when the start timestamp is updated
  /// @param _newStartTimestamp The new timestamp when auxiliary fees begin
  event StartTimestamp(uint64 _newStartTimestamp);

  /// @notice Emitted when auxiliary fee configuration is updated
  /// @param _newAuxFeeData The new auxiliary fee configuration
  event AuxFee(AuxFeeData _newAuxFeeData);

  /// @notice Emitted when addresses are exempted or un-exempted from auxiliary fees
  /// @param _addrs Array of addresses whose exemption status changed
  /// @param _exempt Whether the addresses are now exempted (true) or not (false)
  event Exempt(address[] _addrs, bool _exempt);

  /// @notice Initialize the plugin externally
  /// @dev This function allows to initialize the plugin if it was created after the pool was created
  function initialize() external;

  /// @notice Set exemption status for multiple addresses
  /// @dev Only callable by authorized address
  /// @param _addrs Array of addresses to update exemption status for
  /// @param _exempt True to exempt addresses from auxiliary fees, false to remove exemption
  function exempt(address[] calldata _addrs, bool _exempt) external;

  /// @notice Set the timestamp when auxiliary fees begin, used to delay the start of anti-sniper protection
  /// @dev Only callable by authorized address
  /// @param _newStartTimestamp Unix timestamp when auxiliary fees should start being applied
  function setStartTimestamp(uint64 _newStartTimestamp) external;

  /// @notice Update the auxiliary fee configuration
  /// @dev Only callable by authorized address
  /// @param _newValue New auxiliary fee configuration
  function setAuxFeeData(AuxFeeData memory _newValue) external;

  /// @notice Check if the plugin has been initialized
  /// @dev Returns true if initialize() has been successfully called
  /// @return initialized Whether the plugin is initialized and ready to use
  function isInitialized() external view returns (bool initialized);

  /// @notice Check if a specific address is exempted from auxiliary fees
  /// @dev Exempted addresses bypass the anti-sniper fee mechanism
  /// @param user Address to check exemption status for
  /// @return exempted Whether the address is exempted from auxiliary fees
  function isExempted(address user) external view returns (bool exempted);

  /// @notice Get the current fee configuration
  /// @dev Returns all relevant information about the current auxiliary fee setup
  /// @return startTimestamp_ Unix timestamp when auxiliary fees started/will start
  /// @return feeReceiver_ Address that receives auxiliary fees
  /// @return period_ Duration in seconds for which auxiliary fees are active
  /// @return startingFee_ Initial fee percentage at the start of the period
  /// @return currentAuxFee_ Current auxiliary fee percentage (may decay over time)
  /// @return disabledPriorStart_ Whether auxiliary fees are disabled before start timestamp
  function feeConfig()
    external
    view
    returns (uint256 startTimestamp_, address feeReceiver_, uint24 period_, uint24 startingFee_, uint24 currentAuxFee_, bool disabledPriorStart_);
}
