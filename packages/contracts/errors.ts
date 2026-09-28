import { HttpException } from '@nestjs/common';

export class ApiError extends HttpException {
  constructor(public readonly code: string, message: string, status = 400) {
    super({ code, message }, status);
  }
}
export function invariant(condition: unknown, code: string, message: string, status = 409): asserts condition {
  if (!condition) throw new ApiError(code, message, status);
}
