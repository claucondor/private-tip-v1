"use client";

/// Client-side wrapper for FlowProvider.
///
/// Next.js App Router requires "use client" for React context providers.
/// This wrapper isolates the FlowProvider so the layout (server component)
/// can compose it cleanly without making the entire tree a client component.

import { FlowProvider } from "@onflow/react-sdk";
import { flowConfig } from "@/lib/fcl-config";
import flowJSON from "../flow.json";

export default function FlowProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <FlowProvider
      config={flowConfig}
      flowJson={flowJSON}
      colorMode="system"
    >
      {children}
    </FlowProvider>
  );
}
