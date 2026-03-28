// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IRewardsProgram.sol";

/// @title TokenAccountingLib
/// @notice Library for token balance accounting, lock management, and withdrawals
library TokenAccountingLib {
    uint8 constant MAX_TIME_LOCK_TRANCHES = 50;
    uint32 constant MAX_LOCK_TIME_DAYS = 1095; // 365 * 3

    /// @dev Safe downcast from uint256 to uint128, reverts on overflow
    function _safeU128(uint256 v) private pure returns (uint128) {
        assert(v <= type(uint128).max);
        return uint128(v);
    }

    /// @notice Credit tokens to a member's available balance (deposit)
    /// @param balances Storage mapping of balances
    /// @param programId The program ID
    /// @param wallet The member's wallet
    /// @param amount The amount to credit
    function creditAvailable(
        mapping(uint32 => mapping(address => IRewardsProgram.Balance)) storage balances,
        uint32 programId,
        address wallet,
        uint256 amount
    ) internal {
        if (amount == 0) revert IRewardsProgram.InvalidAmount();
        balances[programId][wallet].available += amount;
    }

    /// @notice Transfer tokens from sender to receiver with lock parameters
    /// @param balances Storage mapping of balances
    /// @param timeLocks Storage mapping of time lock tranches
    /// @param programId The program ID
    /// @param from Sender address
    /// @param to Receiver address
    /// @param amount Amount to transfer
    /// @param locked Whether tokens are permanently locked
    /// @param lockTimeDays Lock duration in days (0 = no time lock)
    function transferToSubMember(
        mapping(uint32 => mapping(address => IRewardsProgram.Balance)) storage balances,
        mapping(uint32 => mapping(address => IRewardsProgram.TimeLockTranche[])) storage timeLocks,
        uint32 programId,
        address from,
        address to,
        uint256 amount,
        bool locked,
        uint32 lockTimeDays
    ) internal {
        if (amount == 0) revert IRewardsProgram.InvalidAmount();
        if (lockTimeDays > MAX_LOCK_TIME_DAYS) revert IRewardsProgram.LockTimeTooLong();
        if (amount > type(uint128).max) revert IRewardsProgram.InvalidAmount();

        IRewardsProgram.Balance storage senderBal = balances[programId][from];
        if (senderBal.available < amount) {
            revert IRewardsProgram.InsufficientBalance(amount, senderBal.available);
        }

        // Deduct from sender's available
        senderBal.available -= amount;

        // Credit to receiver based on lock params
        if (locked) {
            balances[programId][to].permanentlyLocked += amount;
        } else if (lockTimeDays > 0) {
            IRewardsProgram.TimeLockTranche[] storage tranches = timeLocks[programId][to];
            if (tranches.length >= MAX_TIME_LOCK_TRANCHES) {
                revert IRewardsProgram.MaxTimeLockTranchesReached();
            }
            tranches.push(IRewardsProgram.TimeLockTranche({
                amount: uint128(amount),
                unlockTime: uint64(block.timestamp + uint256(lockTimeDays) * 1 days)
            }));
        } else {
            balances[programId][to].available += amount;
        }
    }

    /// @notice Transfer tokens back to a parent in the hierarchy
    /// @dev Deducts in order: available -> expired tranches -> unexpired tranches -> permanentlyLocked
    /// @param balances Storage mapping of balances
    /// @param timeLocks Storage mapping of time lock tranches
    /// @param programId The program ID
    /// @param from The member transferring back
    /// @param to The parent receiving tokens
    /// @param amount The amount to transfer
    function transferToParent(
        mapping(uint32 => mapping(address => IRewardsProgram.Balance)) storage balances,
        mapping(uint32 => mapping(address => IRewardsProgram.TimeLockTranche[])) storage timeLocks,
        uint32 programId,
        address from,
        address to,
        uint256 amount
    ) internal {
        if (amount == 0) revert IRewardsProgram.InvalidAmount();

        uint256 totalBalance = getTotalBalance(balances, timeLocks, programId, from);
        if (totalBalance < amount) {
            revert IRewardsProgram.InsufficientBalance(amount, totalBalance);
        }

        uint256 remaining = amount;
        IRewardsProgram.Balance storage fromBal = balances[programId][from];

        // 1. Deduct from available first
        if (remaining > 0 && fromBal.available > 0) {
            uint256 fromAvail = fromBal.available < remaining ? fromBal.available : remaining;
            fromBal.available -= fromAvail;
            remaining -= fromAvail;
        }

        // 2. Deduct from time-locked tranches (expired first, then unexpired)
        if (remaining > 0) {
            remaining = _deductFromTranches(timeLocks, programId, from, remaining);
        }

        // 3. Deduct from permanently locked
        if (remaining > 0) {
            fromBal.permanentlyLocked -= remaining;
            remaining = 0;
        }

        // Credit to parent's available
        balances[programId][to].available += amount;
    }

    /// @notice Resolve expired time locks and withdraw available tokens
    /// @param balances Storage mapping of balances
    /// @param timeLocks Storage mapping of time lock tranches
    /// @param programId The program ID
    /// @param wallet The member withdrawing
    /// @param amount The amount to withdraw
    /// @return withdrawAmount The actual amount to withdraw from StakingPool
    /// @return resolvedAmount The amount resolved from expired time locks
    function withdraw(
        mapping(uint32 => mapping(address => IRewardsProgram.Balance)) storage balances,
        mapping(uint32 => mapping(address => IRewardsProgram.TimeLockTranche[])) storage timeLocks,
        uint32 programId,
        address wallet,
        uint256 amount
    ) internal returns (uint256 withdrawAmount, uint256 resolvedAmount) {
        if (amount == 0) revert IRewardsProgram.InvalidAmount();

        // Resolve expired time locks first
        resolvedAmount = _resolveExpiredLocks(balances, timeLocks, programId, wallet);

        IRewardsProgram.Balance storage bal = balances[programId][wallet];
        if (bal.available < amount) {
            revert IRewardsProgram.InsufficientBalance(amount, bal.available);
        }

        bal.available -= amount;
        withdrawAmount = amount;
    }

    /// @notice Get total balance across all buckets
    function getTotalBalance(
        mapping(uint32 => mapping(address => IRewardsProgram.Balance)) storage balances,
        mapping(uint32 => mapping(address => IRewardsProgram.TimeLockTranche[])) storage timeLocks,
        uint32 programId,
        address wallet
    ) internal view returns (uint256) {
        IRewardsProgram.Balance storage bal = balances[programId][wallet];
        uint256 total = bal.available + bal.permanentlyLocked;

        IRewardsProgram.TimeLockTranche[] storage tranches = timeLocks[programId][wallet];
        for (uint256 i = 0; i < tranches.length; i++) {
            total += tranches[i].amount;
        }
        return total;
    }

    /// @notice Get effective balance with time-lock resolution (view-only, no state change)
    /// @return withdrawable Amount that can be withdrawn now
    /// @return permLocked Permanently locked amount
    /// @return timeLocked Amount still under time lock
    function getEffectiveBalance(
        mapping(uint32 => mapping(address => IRewardsProgram.Balance)) storage balances,
        mapping(uint32 => mapping(address => IRewardsProgram.TimeLockTranche[])) storage timeLocks,
        uint32 programId,
        address wallet
    ) internal view returns (uint256 withdrawable, uint256 permLocked, uint256 timeLocked) {
        IRewardsProgram.Balance storage bal = balances[programId][wallet];
        withdrawable = bal.available;
        permLocked = bal.permanentlyLocked;

        IRewardsProgram.TimeLockTranche[] storage tranches = timeLocks[programId][wallet];
        for (uint256 i = 0; i < tranches.length; i++) {
            if (tranches[i].unlockTime <= block.timestamp) {
                withdrawable += tranches[i].amount;
            } else {
                timeLocked += tranches[i].amount;
            }
        }
    }

    /// @notice Resolve all expired time lock tranches, moving amounts to available
    /// @return resolved Total amount resolved from expired tranches
    function _resolveExpiredLocks(
        mapping(uint32 => mapping(address => IRewardsProgram.Balance)) storage balances,
        mapping(uint32 => mapping(address => IRewardsProgram.TimeLockTranche[])) storage timeLocks,
        uint32 programId,
        address wallet
    ) internal returns (uint256 resolved) {
        IRewardsProgram.TimeLockTranche[] storage tranches = timeLocks[programId][wallet];
        uint256 i = 0;

        while (i < tranches.length) {
            if (tranches[i].unlockTime <= block.timestamp) {
                resolved += tranches[i].amount;
                // Swap with last and pop
                tranches[i] = tranches[tranches.length - 1];
                tranches.pop();
                // Don't increment i, check swapped element
            } else {
                i++;
            }
        }

        if (resolved > 0) {
            balances[programId][wallet].available += resolved;
        }
    }

    /// @notice Deduct amount from time-locked tranches (expired first, then unexpired)
    /// @return remaining Amount that could not be deducted from tranches
    function _deductFromTranches(
        mapping(uint32 => mapping(address => IRewardsProgram.TimeLockTranche[])) storage timeLocks,
        uint32 programId,
        address wallet,
        uint256 amount
    ) internal returns (uint256 remaining) {
        remaining = amount;
        IRewardsProgram.TimeLockTranche[] storage tranches = timeLocks[programId][wallet];

        // First pass: deduct from expired tranches
        uint256 i = 0;
        while (i < tranches.length && remaining > 0) {
            if (tranches[i].unlockTime <= block.timestamp) {
                uint256 trancheAmt = tranches[i].amount;
                if (trancheAmt <= remaining) {
                    remaining -= trancheAmt;
                    tranches[i] = tranches[tranches.length - 1];
                    tranches.pop();
                } else {
                    tranches[i].amount -= _safeU128(remaining);
                    remaining = 0;
                }
            } else {
                i++;
            }
        }

        // Second pass: deduct from unexpired tranches
        i = 0;
        while (i < tranches.length && remaining > 0) {
            uint256 trancheAmt = tranches[i].amount;
            if (trancheAmt <= remaining) {
                remaining -= trancheAmt;
                tranches[i] = tranches[tranches.length - 1];
                tranches.pop();
            } else {
                tranches[i].amount -= _safeU128(remaining);
                remaining = 0;
            }
        }
    }
}
