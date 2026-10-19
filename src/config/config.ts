import { ENV } from "./env";

const defaults = {
  port: 5001,
};

const config = {
  defaults: defaults,
  apiEndPoint: `http://localhost:${ENV.PORT}/`,
};

export { config };
