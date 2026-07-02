/**
 * Parse Apex stack-trace lines into `{ className, method, line }` frames so a
 * test failure can be turned into a jump-to-source action + a Problems
 * diagnostic. Apex stack lines look like:
 *
 *   Class.MyTest.testThing: line 42, column 1
 *   Class.Some_Namespace.Helper.run: line 7, column 1
 *   Trigger.AccountTrigger: line 12, column 1
 *   Class.MyTest.testThing: line 42, column 1
 *     (System.AssertException: Assertion Failed: …)
 *
 * We keep it deliberately loose: any leading `Class.`/`Trigger.` prefix, a dotted
 * qualified name, then `line N`. `column` is ignored (VS Code diagnostics only
 * need the line). The dotted name's LAST segment is the method (for `Class.`
 * frames); the segment before it is the class. `Trigger.Name` frames have no
 * method.
 */

export interface StackFrame {
  /** Apex class (or trigger) name whose source file we should open. */
  className: string;
  /** Method name, when the frame is a `Class.…` frame with one. */
  method?: string;
  /** 1-based source line from the stack. */
  line: number;
  /** True for a `Trigger.<Name>` frame (opens a `.trigger`, not a `.cls`). */
  isTrigger: boolean;
}

const FRAME_RE =
  /^\s*(Class|Trigger)\.([A-Za-z0-9_.]+?)\s*:\s*line\s+(\d+)(?:\s*,\s*column\s+\d+)?/i;

/** Parse a single stack line into a frame, or null if it isn't a source frame. */
export function parseStackLine(raw: string): StackFrame | null {
  const m = FRAME_RE.exec(raw);
  if (!m) return null;
  const isTrigger = m[1].toLowerCase() === 'trigger';
  const qualified = m[2].split('.').filter(Boolean);
  const line = Number(m[3]);
  if (!Number.isFinite(line) || qualified.length === 0) return null;

  if (isTrigger) {
    // Trigger.<Name> — the whole dotted remainder is the trigger name (triggers
    // aren't nested, but a namespace prefix could appear: take the last segment).
    return { className: qualified[qualified.length - 1], line, isTrigger: true };
  }

  // Class.<...>.<Class>.<method> — last segment is the method, the one before it
  // is the class. A bare `Class.Foo: line N` (no method) keeps Foo as the class.
  if (qualified.length === 1) {
    return { className: qualified[0], line, isTrigger: false };
  }
  const method = qualified[qualified.length - 1];
  const className = qualified[qualified.length - 2];
  return { className, method, line, isTrigger: false };
}

/**
 * Parse a full stack trace (multi-line string) into frames, in order. The first
 * frame is the deepest call site — usually where the failure actually occurred.
 */
export function parseStackTrace(stack: string | null | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split(/\r?\n/)) {
    const frame = parseStackLine(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

/**
 * Pick the most useful frame to jump to for a failure in `preferredClass`
 * (usually the test class that failed). We prefer the first (deepest) frame that
 * names `preferredClass`, because that's the assertion/line inside the test; if
 * none matches, fall back to the first frame overall. Returns null when the
 * stack has no parseable frames.
 */
export function primaryFrame(
  stack: string | null | undefined,
  preferredClass?: string,
): StackFrame | null {
  const frames = parseStackTrace(stack);
  if (frames.length === 0) return null;
  if (preferredClass) {
    const wanted = preferredClass.toLowerCase();
    const match = frames.find((f) => f.className.toLowerCase() === wanted);
    if (match) return match;
  }
  return frames[0];
}
