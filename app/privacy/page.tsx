import type { Metadata } from "next";
import { LEGAL, LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        {LEGAL.appName} (&ldquo;the app&rdquo;, &ldquo;we&rdquo;) lets you write a post once and publish it to the social
        media accounts you connect (Facebook Pages, Instagram professional accounts, LinkedIn, YouTube and TikTok) at a
        time you choose. The app is operated by {LEGAL.operator}, {LEGAL.location}. This policy explains what data the
        app handles and why.
      </p>

      <h2>Data we collect</h2>
      <ul>
        <li><b>Your app account:</b> name, email address and a securely hashed password (we never store your password in plain text).</li>
        <li><b>Connected social accounts:</b> when you click &ldquo;Connect&rdquo; and approve access on Facebook, Instagram, LinkedIn, Google/YouTube or TikTok, we receive access tokens and basic account details (account or Page ID, name, profile picture, and for Instagram the linked business account ID and username).</li>
        <li><b>Content you create:</b> post text, per-platform captions and options, images and videos you upload, schedule times, and the publishing results (post IDs, links, error messages).</li>
        <li><b>Technical logs:</b> request logs (such as IP address and time) kept by our hosting provider for security and troubleshooting.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To publish the posts you schedule to the accounts you selected, at the time you chose.</li>
        <li>To show you your calendar, post status and errors.</li>
        <li>To keep the service secure (for example, limiting repeated login attempts).</li>
      </ul>
      <p>
        We do <b>not</b> sell your data, use it for advertising, or read your accounts beyond what is needed to publish
        your posts. We only request the permissions needed to list the Pages/accounts you manage and to publish content
        to them.
      </p>

      <h2>Data from Meta (Facebook and Instagram)</h2>
      <p>
        Data received through Meta&rsquo;s APIs is used only to publish content you create to the Facebook Pages and
        Instagram accounts you choose, and to show you the result. It is not shared with third parties other than the
        platform you publish to, and it is handled in line with the Meta Platform Terms.
      </p>

      <h2>Sharing</h2>
      <p>
        Your content is sent only to the social platforms you select for each post. Our service providers process data
        on our behalf to run the app: Railway (application hosting and storage). Uploaded media is served from a
        hard-to-guess public link so that platforms such as Instagram can download it while publishing.
      </p>

      <h2>Security</h2>
      <p>
        Access tokens are encrypted at rest (AES-256-GCM), passwords are hashed, and all traffic uses HTTPS. No system is
        perfectly secure, but we work to protect your data.
      </p>

      <h2>Retention and deletion</h2>
      <ul>
        <li>Disconnecting an account in the app deletes its stored tokens immediately.</li>
        <li>You can delete posts at any time from the app.</li>
        <li>To delete your whole account and all associated data, follow the steps on our <a className="text-indigo-600" href="/data-deletion">Data Deletion</a> page. We complete requests within 30 days.</li>
        <li>You can also remove the app&rsquo;s access from your Facebook settings (Settings &amp; privacy → Settings → Business integrations / Apps and websites).</li>
      </ul>

      <h2>Your rights</h2>
      <p>You can ask us to access, correct, export or delete your personal data by emailing us.</p>

      <h2>Children</h2>
      <p>The app is not intended for anyone under 18.</p>

      <h2>Changes</h2>
      <p>We may update this policy. The &ldquo;Last updated&rdquo; date above shows the latest version.</p>

      <h2>Contact</h2>
      <p>
        {LEGAL.operator}, {LEGAL.location} — <a className="text-indigo-600" href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>
      </p>
    </LegalPage>
  );
}
