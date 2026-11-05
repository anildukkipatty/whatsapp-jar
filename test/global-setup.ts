import { Client } from "pg";
import { migrate } from "../scripts/migrate";

export default async function setup() {
  const admin = new Client({ connectionString: "postgres://jar:jar@127.0.0.1:5433/whatsapp_jar" });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS whatsapp_jar_test WITH (FORCE)");
  await admin.query("CREATE DATABASE whatsapp_jar_test");
  await admin.end();
  await migrate("postgres://jar:jar@127.0.0.1:5433/whatsapp_jar_test");
}
