import Bugsnag from "@bugsnag/js";
import BugsnagPluginExpress from "@bugsnag/plugin-express";
import { ApiVersion, Shopify } from "@shopify/shopify-api";
import cookieParser from "cookie-parser";
import "dotenv/config";
import express from "express";
import { resolve } from "path";
import {
  deleteCallback,
  loadCallback,
  storeCallback,
} from "./database/sessions/handlers.js";
// database
import { getShop } from "./database/shops/handlers.js";
// middleware
import applyAuthMiddleware from "./middleware/auth.js";
import verifyRequest from "./middleware/verify-request.js";
import billingRoutes from "./routes/billing/index.js";
// webhooks
import webhookGdprRoutes from "./webhooks/gdpr.js";
import { uninstall } from "./webhooks/uninstall.js";

// Bugsnag
const bugsnagApiKey = process.env.BUGSNAG_API_KEY ? true : false;
if (bugsnagApiKey) {
  Bugsnag.start({
    apiKey: process.env.BUGSNAG_API_KEY,
    plugins: [BugsnagPluginExpress],
  });
} else {
  console.warn(`Missing BUGSNAG_API_KEY environment variable`);
}
const BugsnagMiddleware = bugsnagApiKey && Bugsnag.getPlugin("express");

const USE_ONLINE_TOKENS = true;
const TOP_LEVEL_OAUTH_COOKIE = "shopify_top_level_oauth";

const PORT = parseInt(process.env.PORT || "8081", 10);
const isTest = process.env.NODE_ENV === "test" || !!process.env.VITE_TEST_BUILD;

Shopify.Context.initialize({
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
  SCOPES: process.env.SCOPES.split(","),
  HOST_NAME: process.env.HOST.replace(/https:\/\//, ""),
  API_VERSION: ApiVersion.April22,
  IS_EMBEDDED_APP: true,
  SESSION_STORAGE: new Shopify.Session.CustomSessionStorage(
    storeCallback,
    loadCallback,
    deleteCallback
  ),
});

Shopify.Webhooks.Registry.addHandler("APP_UNINSTALLED", {
  path: "/webhooks",
  webhookHandler: async (_topic, shop, _body) => {
    await uninstall(shop);
  },
});

// export for test use only
export async function createServer(
  root = process.cwd(),
  isProd = process.env.NODE_ENV === "production"
) {
  const app = express();

  /**
   * @type {import('vite').ViteDevServer}
   */
  let vite;

  // Bugsnag Middleware
  // -- must be first to catch any error downstream
  if (bugsnagApiKey) {
    app.use(BugsnagMiddleware.requestHandler);
  }

  app.set("top-level-oauth-cookie", TOP_LEVEL_OAUTH_COOKIE);
  app.set("use-online-tokens", USE_ONLINE_TOKENS);

  app.use(cookieParser(Shopify.Context.API_SECRET_KEY));

  applyAuthMiddleware(app);

  app.post("/webhooks", async (req, res) => {
    try {
      await Shopify.Webhooks.Registry.process(req, res);
      console.log(`Webhook processed, returned status code 200`);
    } catch (error) {
      console.log(`Failed to process webhook: ${error}`);
      res.status(500).send(error.message);
    }
  });

  app.get("/products-count", verifyRequest(app), async (req, res) => {
    const session = await Shopify.Utils.loadCurrentSession(req, res, true);
    const { Product } = await import(
      `@shopify/shopify-api/dist/rest-resources/${Shopify.Context.API_VERSION}/index.js`
    );

    // const allProducts = await Product.all({
    //   session,
    //   limit: 250,
    //   status: "active",
    // });

    const countData = await Product.count({ session });
    res.status(200).send(countData);
  });

  app.post("/graphql", verifyRequest(app), async (req, res) => {
    try {
      const response = await Shopify.Utils.graphqlProxy(req, res);
      res.status(200).send(response.body);
    } catch (error) {
      res.status(500).send(error.message);
    }
  });

  app.use(express.json());

  // GDPR WEBHOOK ROUTES
  webhookGdprRoutes(app);

  // BILLING ROUTES
  billingRoutes(app);

  app.use((req, res, next) => {
    const shop = req.query.shop;
    if (Shopify.Context.IS_EMBEDDED_APP && shop) {
      res.setHeader(
        "Content-Security-Policy",
        `frame-ancestors https://${shop} https://admin.shopify.com;`
      );
    } else {
      res.setHeader("Content-Security-Policy", `frame-ancestors 'none';`);
    }
    next();
  });

  app.use("/*", async (req, res, next) => {
    const shop = req.query.shop;

    if (!shop) {
      next();
      return;
    }

    // Detect whether we need to reinstall the app, any request from Shopify will
    // include a shop in the query parameters.
    // @ts-ignore
    const activeShop = await getShop(shop);

    if (activeShop === null || (activeShop && !activeShop.isInstalled)) {
      res.redirect(`/auth?shop=${shop}`);
      return;
    }

    next();
  });

  if (!isProd) {
    vite = await import("vite").then(({ createServer }) =>
      createServer({
        root,
        logLevel: isTest ? "error" : "info",
        server: {
          port: PORT,
          hmr: {
            protocol: "ws",
            host: "localhost",
            port: 64999,
            clientPort: 64999,
          },
          middlewareMode: "html",
        },
      })
    );
    app.use(vite.middlewares);
  } else {
    const compression = await import("compression").then(
      ({ default: fn }) => fn
    );
    const serveStatic = await import("serve-static").then(
      ({ default: fn }) => fn
    );
    const fs = await import("fs");
    app.use(compression());
    app.use(serveStatic(resolve("dist/client")));
    app.use("/*", (req, res, next) => {
      // Client-side routing will pick up on the correct route to render, so we always render the index here
      res
        .status(200)
        .set("Content-Type", "text/html")
        .send(fs.readFileSync(`${process.cwd()}/dist/client/index.html`));
    });
  }

  if (bugsnagApiKey) {
    app.use(BugsnagMiddleware.errorHandler);
  }

  return { app, vite };
}

if (!isTest) {
  createServer().then(({ app }) => app.listen(PORT));
}
