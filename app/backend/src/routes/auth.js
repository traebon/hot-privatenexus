import { Router } from "express";
import { Issuer, generators } from "openid-client";
import { readFileSync } from "fs";
import { recordAudit } from "../auditLog.js";

export const authRouter = Router();

const KEYCLOAK_URL   = process.env.KEYCLOAK_URL   || "https://auth.house-of-trae.com";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "securenexus";
const CLIENT_ID      = process.env.KEYCLOAK_CLIENT_ID || "privatenexus";
const REDIRECT_URI   = process.env.AUTH_REDIRECT_URI  || "https://privatenexus.net/api/auth/callback";
const POST_LOGOUT_URI = process.env.AUTH_POST_LOGOUT_URI || "https://privatenexus.net";

function readSecret(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

const CLIENT_SECRET = readSecret("/run/secrets/keycloak_client_secret") ?? process.env.KEYCLOAK_CLIENT_SECRET;

let oidcClient = null;

async function getClient() {
  if (oidcClient) return oidcClient;
  const issuer = await Issuer.discover(`${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`);
  oidcClient = new issuer.Client({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uris: [REDIRECT_URI],
    response_types: ["code"],
  });
  return oidcClient;
}

authRouter.get("/login", async (req, res) => {
  try {
    const client = await getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    req.session.oidcState = state;
    req.session.oidcNonce = nonce;
    await new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve()))
    );
    res.redirect(client.authorizationUrl({ scope: "openid profile email", state, nonce }));
  } catch (err) {
    res.status(500).send(`Auth init failed: ${err.message}`);
  }
});

authRouter.get("/callback", async (req, res) => {
  try {
    const client = await getClient();
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(REDIRECT_URI, params, {
      state: req.session.oidcState,
      nonce: req.session.oidcNonce,
    });
    const claims = tokenSet.claims();
    req.session.user = {
      sub:      claims.sub,
      name:     claims.name || claims.preferred_username,
      username: claims.preferred_username,
      email:    claims.email || "",
      roles:    claims.realm_access?.roles?.filter((r) => !r.startsWith("default-")) ?? [],
    };
    req.session.idToken = tokenSet.id_token;
    delete req.session.oidcState;
    delete req.session.oidcNonce;
    await new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve()))
    );
    recordAudit(req, "auth.login", null, "success");
    res.redirect("/");
  } catch (err) {
    res.status(500).send(`Auth callback failed: ${err.message}`);
  }
});

authRouter.get("/logout", (req, res) => {
  const userSnap = req.session?.user ? { ...req.session.user, role: null } : null;
  const idTokenHint = req.session?.idToken || "";
  if (userSnap) recordAudit(req, "auth.logout", null, "success", null, userSnap);
  req.session.destroy(() => {
    const logoutUrl = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/logout`
      + `?client_id=${CLIENT_ID}`
      + `&post_logout_redirect_uri=${encodeURIComponent(POST_LOGOUT_URI)}`
      + (idTokenHint ? `&id_token_hint=${encodeURIComponent(idTokenHint)}` : "");
    res.redirect(logoutUrl);
  });
});

authRouter.get("/me", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Unauthenticated" });
  res.json(req.session.user);
});
