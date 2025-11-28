/**
 * Custom sanitizer definitions for the scraper service.
 *
 * This library defines our sanitization functions as barriers in taint tracking,
 * teaching CodeQL that data passing through these functions is safe for logging.
 *
 * Sanitizer Functions (in src/utils/security.ts):
 * - sanitizeForLog: Removes newlines, ANSI codes, control chars from strings
 * - sanitizeObjectForLog: Sanitizes object serialization for safe logging
 */

import javascript
import semmle.javascript.dataflow.DataFlow

/**
 * A call to one of our custom sanitizer functions.
 */
class SanitizerCall extends DataFlow::CallNode {
  SanitizerCall() {
    exists(string name |
      name = ["sanitizeForLog", "sanitizeObjectForLog"] and
      this.getCalleeName() = name
    )
  }
}

/**
 * A module that can be used to identify our sanitizers as barriers.
 */
module CustomSanitizers {
  /**
   * Holds if `node` is a call to one of our custom sanitizer functions,
   * which makes it a valid sanitization barrier.
   */
  predicate isSanitizer(DataFlow::Node node) {
    node instanceof SanitizerCall
  }
}
