import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import AppShell from "@/components/AppShell";
import RunProvider from "@/components/RunProvider";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  // RunProvider lives here, above both /agent and /board, because this layout
  // does not re-render when navigating between them -- which is what lets an
  // agent run survive switching to the board to watch its leads arrive.
  return (
    <RunProvider>
      <AppShell name={session.name}>{children}</AppShell>
    </RunProvider>
  );
}
