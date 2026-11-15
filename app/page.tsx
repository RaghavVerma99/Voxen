import { connection } from "next/server";
import VoiceAgent from "./components/VoiceAgent";

export default async function Home() {
  // The CSP nonce is issued per request, so the page must render per request.
  await connection();
  return <VoiceAgent />;
}
