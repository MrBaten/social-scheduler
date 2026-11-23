import type { Metadata } from "next";
import { LEGAL, LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = { title: "Data Deletion Instructions" };

export default function DataDeletionPage() {
  return (
    <LegalPage title="Data Deletion Instructions">
      <p>You can remove your data from {LEGAL.appName} at any time.</p>

      <h2>Remove a connected Facebook, Instagram or other account</h2>
      <ul>
        <li>Sign in to the app and open <b>Accounts</b>.</li>
        <li>Click <b>Disconnect</b> next to the account. Its access tokens are deleted from our database immediately.</li>
        <li>Optionally, also remove the app in Facebook: Settings &amp; privacy → Settings → Business integrations (or Apps and websites) → select the app → Remove.</li>
      </ul>

      <h2>Delete your whole app account and all data</h2>
      <ul>
        <li>Email <a className="text-indigo-600" href={`mailto:${LEGAL.email}?subject=Data%20deletion%20request`}>{LEGAL.email}</a> with the subject &ldquo;Data deletion request&rdquo; from the email address you signed up with.</li>
        <li>We delete your account, connected-account tokens, posts, uploaded media and publishing history within 30 days and confirm by email.</li>
      </ul>

      <p>
        Posts that were already published to Facebook, Instagram or other platforms stay on those platforms; delete them
        there if you want them removed.
      </p>
    </LegalPage>
  );
}
