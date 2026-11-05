export class HttpError extends Error {
  constructor(status, message, { type = 'invalid_request_error', code = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.type = type;
    this.code = code;
  }
}
