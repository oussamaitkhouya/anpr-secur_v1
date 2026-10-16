/** Error shape shared by the mock and the HTTP client, modelled on FastAPI's {"detail": ...}. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const forbidden = (what: string) => new ApiError(403, `Your role is not allowed to ${what}.`);
export const notFound = (what: string) => new ApiError(404, `${what} not found.`);
export const badRequest = (message: string) => new ApiError(422, message);
export const conflict = (message: string) => new ApiError(409, message);
