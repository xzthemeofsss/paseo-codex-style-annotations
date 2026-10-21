import type { PluginAgentPanelProps, PluginClientContext } from "@getpaseo/plugin/client";
import { SideChatPanel } from "./client/side-chat-panel";
import { installSelectionBar } from "./client/web";
import { createAnnotationPreferences } from "./client/annotation-preferences";
import { installAnnotationSettings } from "./client/annotation-settings";
import { createSettingsLanguage } from "./client/settings-language";
import { installPluginCardName } from "./client/plugin-card-name";

export default function contribute(client: PluginClientContext) {
  const preferences = createAnnotationPreferences(client);
  const language = createSettingsLanguage();
  const removeSettings = installAnnotationSettings(client, preferences, language);
  const removePanel = client.addWorkspacePanel({
    id: "side-chat",
    title: "Side chat",
    icon: "MessagesSquare",
    context: "agent",
    locations: ["explorer", "workspace"],
    Component: (props: PluginAgentPanelProps) => <SideChatPanel {...props} language={language} />,
  });
  const removeBar = installSelectionBar(client, preferences, language);
  const removeCardName = installPluginCardName();
  return () => {
    removeCardName();
    removeBar();
    removePanel(); removeSettings(); language.dispose(); preferences.dispose();
  };
}
