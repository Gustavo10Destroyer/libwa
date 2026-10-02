/**
 * Process-wide monotonic counter used to keep generated ids unique.
 *
 * Several ids are built from a timestamp (an edit and a delete of one message
 * produced in the same millisecond, two group updates for one group). The
 * timestamp stays the readable prefix; this counter is what guarantees that
 * two events never share an id.
 */

let sequence = 0;

/**
 * Next value of the process-wide sequence. Returns a plain `number` so ids
 * keep a compact suffix; it only wraps after 2^53 ids, which no process
 * reaches in practice.
 */
export function nextSequence(): number {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return sequence;
}
