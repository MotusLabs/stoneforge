/**
 * Error-mapping helpers for shared route factories
 */

import { isStoneforgeError } from '@stoneforge/core';
import type { StoneforgeError } from '@stoneforge/core';

/**
 * True when the error should surface as HTTP 400 (Bad Request).
 *
 * Core factories throw `ValidationError` (a `StoneforgeError`) with codes like
 * `INVALID_INPUT` or `INVALID_ID` — never the literal `'VALIDATION_ERROR'`
 * string that routes previously compared against, so those errors fell through
 * to 500. Every `StoneforgeError` carries an `httpStatus` derived from the
 * central `ErrorHttpStatus` table; checking it maps all validation-class
 * failures (and 400-mapped constraint failures such as `TYPE_MISMATCH`) to
 * 400 regardless of the specific code string.
 */
export function isBadRequestError(error: unknown): error is StoneforgeError {
  return isStoneforgeError(error) && error.httpStatus === 400;
}
