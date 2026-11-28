import { connection } from "next/server";
import { redirect } from "next/navigation";
import { signOut } from "@/lib/auth";
import { access } from "@/lib/owner";

// Shown to anyone who is not the owner. Nothing about the apps is loaded here.

type Props = { searchParams: Promise<{ email?: string }> };

export default async function NoAccess({ searchParams }: Props) {
  await connection();
  const who = await access();
  if (who.state === "owner") redirect("/");
  const typed = (await searchParams).email;
  const email = who.state === "no-access" ? who.user.email : typed && typed.length < 200 ? typed : null;

  return (
    <main className="db-noaccess">
      <img src="/mark.svg" alt="" width={44} height={44} />
      <h1>No access</h1>
      <p>
        This is a private dashboard. {email ? <><strong>{email}</strong> is not on its list,</> : "Your account is not on its list,"} so there is
        nothing to see here.
      </p>
      <p className="db-muted">If this is your Runport, sign in with the email you set it up with.</p>
      <form action={signOut}>
        <button className="db-btn db-btn-primary">Use another email</button>
      </form>
    </main>
  );
}
