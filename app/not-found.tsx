import Link from "next/link";
import { connection } from "next/server";
import { WaveIcon } from "./components/Icons";

// Unknown paths must be rendered per request so the CSP nonce is available.
export const dynamic = "force-dynamic";

export default async function NotFound() {
  await connection();

  return (
    <main className="gate">
      <div className="gate-card">
        <span className="brand-mark" aria-hidden="true">
          <WaveIcon size={22} />
        </span>
        <h1>Page not found</h1>
        <p>
          The page you&apos;re looking for doesn&apos;t exist. Head back to the
          conversation.
        </p>
        <Link className="btn primary block" href="/">
          Back to Voxen
        </Link>
      </div>
    </main>
  );
}
