import axios from "axios";

/**
 * Builds an axios instance pointed at the current backend base URL.
 * We create a fresh instance per call (cheap) instead of a module-level
 * singleton so a Settings change takes effect immediately everywhere,
 * without needing to thread a "rebuild client" event through the app.
 */
export function makeClient(baseUrl, { timeoutMs = 20000 } = {}) {
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: { "Content-Type": "application/json" },
  });
}

/** Normalizes axios errors into a short, user-showable string. */
export function describeApiError(error) {
  if (error?.response) {
    const detail = error.response.data?.detail || error.response.data?.error;
    return detail || `Server responded with ${error.response.status}`;
  }
  if (error?.request) {
    return "Couldn't reach the backend. Check the server URL in Settings and that the FastAPI server is running.";
  }
  return error?.message || "Something went wrong.";
}
