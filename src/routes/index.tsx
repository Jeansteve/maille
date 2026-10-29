import { createFileRoute } from "@tanstack/react-router";
import { MailleApp } from "@/components/maille-app";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <MailleApp />;
}
