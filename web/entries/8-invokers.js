// Invoker commands (Safari 26.2): <button command="show-modal" commandfor="id">
// opens dialogs and popovers without script. ChatGPT's Log in button uses it.
import { apply, isSupported } from 'invokers-polyfill/fn';
if (!isSupported()) apply();
