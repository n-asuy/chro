import { createServer as createNetServer } from "node:net";

export const isPortAvailable = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const tester = createNetServer();
    tester.once("error", () => {
      tester.close(() => resolve(false));
    });
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });

export const findAvailablePort = async (
  startPort: number,
  host: string,
): Promise<number> => {
  let attempt = startPort;
  while (!(await isPortAvailable(attempt, host))) {
    attempt += 1;
  }
  return attempt;
};
