export interface Bindings {
  DB: D1Database;

  ADMIN_USER: string;
  ADMIN_PASS: string;
  ADMIN_JWT_KEY: string;
  USER_JWT_KEY: string;

  TURSO_URL: string;
  TURSO_TOKEN: string;

  B2_KEY_ID: string;
  B2_APP_KEY: string;
  B2_BUCKET_NAME: string;
  B2_S3_ENDPOINT: string;

  FORMSUBMIT_EMAIL: string;
  FRONTEND_ORIGIN: string;
}
