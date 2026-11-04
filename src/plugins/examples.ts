import source from "../../plugins/examples/ideas.lightpen-plugin?raw";
import type { PluginPackage } from "./types";
export const EXAMPLE_PLUGIN = JSON.parse(source) as PluginPackage;
