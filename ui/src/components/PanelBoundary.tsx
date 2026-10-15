import { Component, type ReactNode } from "react";
import ui from "../styles/ui.module.css";

/** Keeps a failure while rendering one tab from blanking the whole window. */
export class PanelBoundary extends Component<{ children: ReactNode }, { failure: string | undefined }> {
  override state = { failure: undefined as string | undefined };
  static getDerivedStateFromError(error: unknown) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    if (this.state.failure === undefined) return this.props.children;
    return (
      <div role="alert">
        <p className={ui.danger}>{`This tab could not be shown: ${this.state.failure}`}</p>
        <button type="button" onClick={() => this.setState({ failure: undefined })}>Try again</button>
      </div>
    );
  }
}
