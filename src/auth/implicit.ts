import { Notice } from "obsidian";
import { AnilistClient } from "../anilist/client";
import type AnisyncPlugin from "../main";
import { OAUTH_REDIRECT_URI } from "./constants";

export function openAuthorizePopup(_plugin: AnisyncPlugin): void {
  window.open(OAUTH_REDIRECT_URI, "_blank");
}

export async function handleDeepLinkToken(plugin: AnisyncPlugin, token: string): Promise<void> {
  if (!token || token.length < 10) {
    new Notice("Invalid token received.", 5000);
    return;
  }
  plugin.settings.anilistToken = token;
  await plugin.saveSettings();
  new Notice("Verifying connection...", 3000);
  await probeAnilistConnection(plugin);
}

export async function disconnectAnilist(plugin: AnisyncPlugin): Promise<void> {
  plugin.settings.anilistToken = "";
  plugin.settings.anilistUsername = "";
  await plugin.saveSettings();
  plugin.stopAutoSync();
}

export async function probeAnilistConnection(plugin: AnisyncPlugin): Promise<void> {
  const client = new AnilistClient(plugin.settings.anilistToken);
  try {
    const viewer = await client.fetchViewer();
    plugin.settings.anilistUsername = viewer.name;
    await plugin.saveSettings();
    plugin.refreshSettingsTab();
    new Notice("Connected as @" + viewer.name + "!", 4000);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    plugin.refreshSettingsTab();
    new Notice("Connection failed: " + msg, 8000);
  }
}
