import '@fontsource-variable/noto-sans-sc/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './styles.css';
import { mountApp } from './app/app';

mountApp(document.getElementById('app') as HTMLElement);
