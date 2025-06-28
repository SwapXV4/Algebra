// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.8.4;

/// @title Errors emitted by a pool
/// @notice Contains custom errors emitted by the pool
/// @dev Custom errors are separated from the common pool interface for compatibility with older versions of Solidity
interface IAlgebraPoolErrors {
  // ####  SafeTransfer errors  ####

  /// @notice Emitted if token transfer failed internally
  error transferFailed();

  /// @notice Emitted if token transferFrom failed internally
  error transferFromFailed();
}
