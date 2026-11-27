import { ContactForm } from "@/components/forms";
import { pageMetadata } from "@/lib/seo";

export const generateMetadata = () =>
  pageMetadata({ title: "Contact", description: "Send us a message.", path: "/contact" });

export default function ContactPage() {
  return (
    <main className="mx-auto max-w-lg px-5 py-12 sm:py-20">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Contact</h1>
      <ContactForm />
    </main>
  );
}
