// A stand-in for @forge/events: pushed events wait in globalThis.__queue.
// A test can make pushes fail with globalThis.__queueFail = <how many>.
export class Queue {
  constructor({ key }) {
    this.key = key;
  }
  async push(event) {
    if (globalThis.__queueFail && globalThis.__queueFail-- > 0) throw new Error('InvocationLimitReachedError');
    (globalThis.__queue ??= []).push(JSON.parse(JSON.stringify(event)));
  }
}
export class InvocationError {
  constructor(options) {
    this.options = options;
  }
}
export const InvocationErrorCode = { FUNCTION_UPSTREAM_RATE_LIMITED: 'RATE_LIMITED', FUNCTION_RETRY_REQUEST: 'RETRY' };
