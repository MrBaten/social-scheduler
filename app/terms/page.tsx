import type { Metadata } from "next";
import { LEGAL, LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <p>By using {LEGAL.appName} you agree to these terms.</p>
      <h2>The service</h2>
      <p>The app publishes content you create to social media accounts you connect, at the times you schedule. It is provided &ldquo;as is&rdquo; and may change or be unavailable at times.</p>
      <h2>Your responsibilities</h2>
      <ul>
        <li>Only connect accounts and Pages you are authorised to manage.</li>
        <li>You are responsible for the content you publish and must follow each platform&rsquo;s rules (including Meta&rsquo;s Community Standards and Terms).</li>
        <li>Keep your login details secure.</li>
      </ul>
      <h2>Limits</h2>
      <p>Platforms may reject, delay or limit posts. We are not liable for content not being published or for losses arising from use of the app, to the extent permitted by law.</p>
      <h2>Ending use</h2>
      <p>You can stop using the app and request deletion at any time (see Data Deletion). We may suspend accounts that misuse the service.</p>
      <h2>Contact</h2>
      <p><a className="text-indigo-600" href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a></p>
    </LegalPage>
  );
}
