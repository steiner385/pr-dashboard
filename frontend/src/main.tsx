import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WorkspaceApp } from './shell/WorkspaceApp';
import { workspaceEnabled } from './shell/enabled';
import './styles.css';

// Strangler-fig (flipped): the unified workspace is now the DEFAULT surface; the
// classic App stays reachable as a sticky back-door via ?legacy=1 (or ?workspace=0).
const Root = workspaceEnabled(location.search, localStorage) ? WorkspaceApp : App;
createRoot(document.getElementById('root')!).render(<Root />);
