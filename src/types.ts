/**
 * The shapes this package works in.
 *
 * Re-exported from where they are defined rather than redeclared, so there is
 * one definition of a pointer and one of a batch response, and no chance of the
 * two drifting.
 */

export type { BatchAction, BatchObjectError, BatchObjectRequest, BatchObjectResponse, BatchRejection, BatchRequest, BatchResponse, ObjectState, Operation } from './batch'
export type { Actor, Lock, LockList, LockOutcome, LockOwner, LockRecord, LockStore, VerifyList } from './locks'
export type { Oid, Verification } from './oid'
export type { Pointer } from './pointer'
export type { Authorized, ServerOptions } from './server'
export type { StoredObject, WriteResult } from './storage'
