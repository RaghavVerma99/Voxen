import type { Metadata } from "next";
import { connection } from "next/server";

import AdminDashboard from "../components/AdminDashboard";

export const metadata: Metadata = {
  title: "Admin usage",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  // The CSP nonce is issued per request, so this page renders dynamically.
  await connection();
  return <AdminDashboard />;
}
