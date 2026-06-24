import Docker from "dockerode";

let _client = null;

export function getDocker() {
  if (!_client) {
    const host = process.env.DOCKER_HOST;
    if (host) {
      const url = new URL(host.replace(/^tcp:\/\//, "http://"));
      _client = new Docker({ host: url.hostname, port: Number(url.port), protocol: "http" });
    } else {
      _client = new Docker({ socketPath: "/var/run/docker.sock" });
    }
  }
  return _client;
}
