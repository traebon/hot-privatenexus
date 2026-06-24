import Docker from "dockerode";

let _client = null;

export function getDocker() {
  if (!_client) {
    const host = process.env.DOCKER_HOST;
    if (host) {
      // The supported deployment routes through docker-socket-proxy (tcp://...docker-proxy:2375)
      // on the internal Docker bridge — plain HTTP on a private network is acceptable.
      // If DOCKER_HOST is ever pointed directly at the Docker daemon TCP port, that would
      // be unauthenticated and unfiltered. Log a warning to catch that misconfiguration.
      const url = new URL(host.replace(/^tcp:\/\//, "http://"));
      const isSocketProxy = url.hostname.includes("docker-proxy") || url.hostname.includes("socket-proxy");
      if (!isSocketProxy) {
        console.warn("[docker] WARNING: DOCKER_HOST TCP target does not look like a socket proxy — " +
          "connecting to a raw Docker daemon over plain HTTP is unauthenticated. " +
          "Use docker-socket-proxy or set DOCKER_TLS_VERIFY=1 with TLS certificates.");
      }
      _client = new Docker({ host: url.hostname, port: Number(url.port), protocol: "http" });
    } else {
      _client = new Docker({ socketPath: "/var/run/docker.sock" });
    }
  }
  return _client;
}
