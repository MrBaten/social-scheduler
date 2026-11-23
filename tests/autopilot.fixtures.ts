import type { FeedItem } from "../lib/autopilot/types";

export const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Dhaka Tech Daily</title>
  <link>https://dhakatech.example</link>
  <item>
    <title><![CDATA[Grameenphone launches 5G service in Dhaka &amp; Chattogram]]></title>
    <link>https://dhakatech.example/news/gp-5g?utm_source=rss&amp;utm_medium=feed</link>
    <guid isPermaLink="false">abc-1</guid>
    <pubDate>Mon, 23 Nov 2026 04:00:00 GMT</pubDate>
    <description>&lt;p&gt;The operator said the &lt;b&gt;5G&lt;/b&gt; rollout starts with 20 sites.&lt;/p&gt;</description>
  </item>
  <item>
    <title>বাংলাদেশে নতুন ফিনটেক স্টার্টআপ চালু</title>
    <link>https://dhakatech.example/bn/fintech</link>
    <pubDate>Mon, 23 Nov 2026 03:00:00 +0600</pubDate>
    <description><![CDATA[ঢাকায় একটি নতুন ফিনটেক স্টার্টআপ যাত্রা শুরু করেছে।]]></description>
  </item>
  <item><title>No link item</title></item>
</channel>
</rss>`;

export const GOOGLE_NEWS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>"Bangladesh technology" - Google News</title>
<item>
  <title>GP rolls out 5G in Dhaka, Chattogram - The Daily Example</title>
  <link>https://news.google.com/rss/articles/CBMiAAA?oc=5</link>
  <guid isPermaLink="false">CBMiAAA</guid>
  <pubDate>Mon, 23 Nov 2026 05:00:00 GMT</pubDate>
  <description>&lt;a href="https://news.google.com/rss/articles/CBMiAAA?oc=5"&gt;GP rolls out 5G in Dhaka, Chattogram&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;The Daily Example&lt;/font&gt;</description>
  <source url="https://dailyexample.com">The Daily Example</source>
</item>
</channel></rss>`;

export const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Startup Blog</title>
  <entry>
    <title type="html">Bkash adds &lt;em&gt;new&lt;/em&gt; savings feature</title>
    <link rel="self" href="https://blog.example/feed/1"/>
    <link rel="alternate" type="text/html" href="https://blog.example/posts/bkash-savings"/>
    <published>2026-11-23T02:00:00Z</published>
    <summary>Mobile wallet bKash added a savings feature for users.</summary>
  </entry>
</feed>`;

export const GDELT_FIXTURE = JSON.stringify({
  articles: [
    {
      url: "https://outlet.example/bd-ai-policy",
      url_mobile: "",
      title: "Bangladesh drafts national AI policy",
      seendate: "20261123T061500Z",
      socialimage: "https://outlet.example/img.jpg",
      domain: "outlet.example",
      language: "English",
      sourcecountry: "Bangladesh",
    },
    { url: "", title: "missing url" },
  ],
});

export function item(over: Partial<FeedItem> & { title: string; url: string }, now: Date): FeedItem {
  return {
    summary: "",
    publisher: "Example",
    published_at: new Date(now.getTime() - 60 * 60_000).toISOString(),
    ...over,
  };
}
