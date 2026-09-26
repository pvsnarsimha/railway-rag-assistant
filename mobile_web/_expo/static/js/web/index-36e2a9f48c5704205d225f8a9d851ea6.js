__d(function(g,r,i,a,m,e,d){"use strict";Object.defineProperty(e,'__esModule',{value:!0});var t=r(d[0]);Object.keys(t).forEach(function(n){'default'===n||Object.prototype.hasOwnProperty.call(e,n)||Object.defineProperty(e,n,{enumerable:!0,get:function(){return t[n]}})})},877,[879]);
__d(function(g,r,_i,a,m,_e2,d){"use strict";Object.defineProperty(_e2,'__esModule',{value:!0}),Object.defineProperty(_e2,"deleteToken",{enumerable:!0,get:function(){return he}}),Object.defineProperty(_e2,"getMessaging",{enumerable:!0,get:function(){return ge}}),Object.defineProperty(_e2,"getToken",{enumerable:!0,get:function(){return we}}),Object.defineProperty(_e2,"isSupported",{enumerable:!0,get:function(){return pe}}),Object.defineProperty(_e2,"onMessage",{enumerable:!0,get:function(){return be}}),r(d[0]);var e=r(d[1]),t=r(d[2]),n=r(d[3]),i=r(d[4]);
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
const o='/firebase-messaging-sw.js',s='/firebase-cloud-messaging-push-scope',c='BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoMj8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4',u='https://fcmregistrations.googleapis.com/v1',p='google.c.a.c_id';var l,f;
/**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
function w(e){const t=new Uint8Array(e);return btoa(String.fromCharCode(...t)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}function h(e){const t=(e+'='.repeat((4-e.length%4)%4)).replace(/\-/g,'+').replace(/_/g,'/'),n=atob(t),i=new Uint8Array(n.length);for(let e=0;e<n.length;++e)i[e]=n.charCodeAt(e);return i}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */!(function(e){e[e.DATA_MESSAGE=1]="DATA_MESSAGE",e[e.DISPLAY_NOTIFICATION=3]="DISPLAY_NOTIFICATION"})(l||(l={})),(function(e){e.PUSH_RECEIVED="push-received",e.NOTIFICATION_CLICKED="notification-clicked"})(f||(f={}));const b='fcm_token_details_db',y=5,v='fcm_token_object_Store';async function k(e){if('databases'in indexedDB){const e=(await indexedDB.databases()).map(e=>e.name);if(!e.includes(b))return null}let n=null;return(await(0,t.openDB)(b,y,{upgrade:async(t,i,o,s)=>{var c;if(i<2)return;if(!t.objectStoreNames.contains(v))return;const u=s.objectStore(v),p=await u.index('fcmSenderId').get(e);if(await u.clear(),p)if(2===i){const e=p;if(!e.auth||!e.p256dh||!e.endpoint)return;n={token:e.fcmToken,createTime:null!==(c=e.createTime)&&void 0!==c?c:Date.now(),subscriptionOptions:{auth:e.auth,p256dh:e.p256dh,endpoint:e.endpoint,swScope:e.swScope,vapidKey:'string'==typeof e.vapidKey?e.vapidKey:w(e.vapidKey)}}}else if(3===i){const e=p;n={token:e.fcmToken,createTime:e.createTime,subscriptionOptions:{auth:w(e.auth),p256dh:w(e.p256dh),endpoint:e.endpoint,swScope:e.swScope,vapidKey:w(e.vapidKey)}}}else if(4===i){const e=p;n={token:e.fcmToken,createTime:e.createTime,subscriptionOptions:{auth:w(e.auth),p256dh:w(e.p256dh),endpoint:e.endpoint,swScope:e.swScope,vapidKey:w(e.vapidKey)}}}}})).close(),await(0,t.deleteDB)(b),await(0,t.deleteDB)('fcm_vapid_details_db'),await(0,t.deleteDB)('undefined'),I(n)?n:null}function I(e){if(!e||!e.subscriptionOptions)return!1;const{subscriptionOptions:t}=e;return'number'==typeof e.createTime&&e.createTime>0&&'string'==typeof e.token&&e.token.length>0&&'string'==typeof t.auth&&t.auth.length>0&&'string'==typeof t.p256dh&&t.p256dh.length>0&&'string'==typeof t.endpoint&&t.endpoint.length>0&&'string'==typeof t.swScope&&t.swScope.length>0&&'string'==typeof t.vapidKey&&t.vapidKey.length>0}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */const S='firebase-messaging-database',T=1,_='firebase-messaging-store';let D=null;function O(){return D||(D=(0,t.openDB)(S,T,{upgrade:(e,t)=>{if(0===t)e.createObjectStore(_)}})),D}async function M(e){const t=P(e),n=await O(),i=await n.transaction(_).objectStore(_).get(t);if(i)return i;{const t=await k(e.appConfig.senderId);if(t)return await C(e,t),t}}async function C(e,t){const n=P(e),i=(await O()).transaction(_,'readwrite');return await i.objectStore(_).put(t,n),await i.done,t}async function K(e){const t=P(e),n=(await O()).transaction(_,'readwrite');await n.objectStore(_).delete(t),await n.done}function P({appConfig:e}){return e.appId}
/**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */const A={"missing-app-config-values":'Missing App configuration value: "{$valueName}"',"only-available-in-window":'This method is available in a Window context.',"only-available-in-sw":'This method is available in a service worker context.',"permission-default":'The notification permission was not granted and dismissed instead.',"permission-blocked":'The notification permission was not granted and blocked instead.',"unsupported-browser":"This browser doesn't support the API's required to use the Firebase SDK.","indexed-db-unsupported":"This browser doesn't support indexedDb.open() (ex. Safari iFrame, Firefox Private Browsing, etc)","failed-service-worker-registration":'We are unable to register the default service worker. {$browserErrorMessage}',"token-subscribe-failed":'A problem occurred while subscribing the user to FCM: {$errorInfo}',"token-subscribe-no-token":'FCM returned no token when subscribing the user to push.',"token-unsubscribe-failed":"A problem occurred while unsubscribing the user from FCM: {$errorInfo}","token-update-failed":'A problem occurred while updating the user from FCM: {$errorInfo}',"token-update-no-token":'FCM returned no token when updating the user to push.',"use-sw-after-get-token":"The useServiceWorker() method may only be called once and must be called before calling getToken() to ensure your service worker is used.","invalid-sw-registration":'The input to useServiceWorker() must be a ServiceWorkerRegistration.',"invalid-bg-handler":'The input to setBackgroundMessageHandler() must be a function.',"invalid-vapid-key":'The public VAPID key must be a string.',"use-vapid-key-after-get-token":"The usePublicVapidKey() method may only be called once and must be called before calling getToken() to ensure your VAPID key is used."},j=new n.ErrorFactory('messaging','Messaging',A);
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
async function E(e,t){const n=await F(e),i=H(t),o={method:'POST',headers:n,body:JSON.stringify(i)};let s;try{const t=await fetch(x(e.appConfig),o);s=await t.json()}catch(e){throw j.create("token-subscribe-failed",{errorInfo:null==e?void 0:e.toString()})}if(s.error){const e=s.error.message;throw j.create("token-subscribe-failed",{errorInfo:e})}if(!s.token)throw j.create("token-subscribe-no-token");return s.token}async function N(e,t){const n=await F(e),i=H(t.subscriptionOptions),o={method:'PATCH',headers:n,body:JSON.stringify(i)};let s;try{const n=await fetch(`${x(e.appConfig)}/${t.token}`,o);s=await n.json()}catch(e){throw j.create("token-update-failed",{errorInfo:null==e?void 0:e.toString()})}if(s.error){const e=s.error.message;throw j.create("token-update-failed",{errorInfo:e})}if(!s.token)throw j.create("token-update-no-token");return s.token}async function R(e,t){const n={method:'DELETE',headers:await F(e)};try{const i=await fetch(`${x(e.appConfig)}/${t}`,n),o=await i.json();if(o.error){const e=o.error.message;throw j.create("token-unsubscribe-failed",{errorInfo:e})}}catch(e){throw j.create("token-unsubscribe-failed",{errorInfo:null==e?void 0:e.toString()})}}function x({projectId:e}){return`${u}/projects/${e}/registrations`}async function F({appConfig:e,installations:t}){const n=await t.getToken();return new Headers({'Content-Type':'application/json',Accept:'application/json','x-goog-api-key':e.apiKey,'x-goog-firebase-installations-auth':`FIS ${n}`})}function H({p256dh:e,auth:t,endpoint:n,vapidKey:i}){const o={web:{endpoint:n,auth:t,p256dh:e}};return i!==c&&(o.web.applicationPubKey=i),o}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */const B=6048e5;async function W(e){const t=await U(e.swRegistration,e.vapidKey),n={vapidKey:e.vapidKey,swScope:e.swRegistration.scope,endpoint:t.endpoint,auth:w(t.getKey('auth')),p256dh:w(t.getKey('p256dh'))},i=await M(e.firebaseDependencies);if(i){if(q(i.subscriptionOptions,n))return Date.now()>=i.createTime+B?L(e,{token:i.token,createTime:Date.now(),subscriptionOptions:n}):i.token;try{await R(e.firebaseDependencies,i.token)}catch(e){console.warn(e)}return V(e.firebaseDependencies,n)}return V(e.firebaseDependencies,n)}async function $(e){const t=await M(e.firebaseDependencies);t&&(await R(e.firebaseDependencies,t.token),await K(e.firebaseDependencies));const n=await e.swRegistration.pushManager.getSubscription();return!n||n.unsubscribe()}async function L(e,t){try{const n=await N(e.firebaseDependencies,t),i=Object.assign(Object.assign({},t),{token:n,createTime:Date.now()});return await C(e.firebaseDependencies,i),n}catch(e){throw e}}async function V(e,t){const n={token:await E(e,t),createTime:Date.now(),subscriptionOptions:t};return await C(e,n),n.token}async function U(e,t){const n=await e.pushManager.getSubscription();return n||e.pushManager.subscribe({userVisibleOnly:!0,applicationServerKey:h(t)})}function q(e,t){const n=t.vapidKey===e.vapidKey,i=t.endpoint===e.endpoint,o=t.auth===e.auth,s=t.p256dh===e.p256dh;return n&&i&&o&&s}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */function G(e){const t={from:e.from,collapseKey:e.collapse_key,messageId:e.fcmMessageId};return z(t,e),J(t,e),Y(t,e),t}function z(e,t){if(!t.notification)return;e.notification={};const n=t.notification.title;n&&(e.notification.title=n);const i=t.notification.body;i&&(e.notification.body=i);const o=t.notification.image;o&&(e.notification.image=o);const s=t.notification.icon;s&&(e.notification.icon=s)}function J(e,t){t.data&&(e.data=t.data)}function Y(e,t){var n,i,o,s,c;if(!t.fcmOptions&&!(null===(n=t.notification)||void 0===n?void 0:n.click_action))return;e.fcmOptions={};const u=null!==(o=null===(i=t.fcmOptions)||void 0===i?void 0:i.link)&&void 0!==o?o:null===(s=t.notification)||void 0===s?void 0:s.click_action;u&&(e.fcmOptions.link=u);const p=null===(c=t.fcmOptions)||void 0===c?void 0:c.analytics_label;p&&(e.fcmOptions.analyticsLabel=p)}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
function Q(e){if(!e||!e.options)throw X('App Configuration Object');if(!e.name)throw X('App Name');const t=['projectId','apiKey','appId','messagingSenderId'],{options:n}=e;for(const e of t)if(!n[e])throw X(e);return{appName:e.name,projectId:n.projectId,apiKey:n.apiKey,appId:n.appId,senderId:n.messagingSenderId}}function X(e){return j.create("missing-app-config-values",{valueName:e})}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
!(function(e,t){const n=[];for(let i=0;i<e.length;i++)n.push(e.charAt(i)),i<t.length&&n.push(t.charAt(i));n.join('')})('AzSCbw63g1R0nCw85jG8','Iaya3yLKwmgvh7cF0q4');class Z{constructor(e,t,n){this.deliveryMetricsExportedToBigQueryEnabled=!1,this.onBackgroundMessageHandler=null,this.onMessageHandler=null,this.logEvents=[],this.isLogServiceStarted=!1;const i=Q(e);this.firebaseDependencies={app:e,appConfig:i,installations:t,analyticsProvider:n}}_delete(){return Promise.resolve()}}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function ee(e){try{e.swRegistration=await navigator.serviceWorker.register(o,{scope:s}),e.swRegistration.update().catch(()=>{})}catch(e){throw j.create("failed-service-worker-registration",{browserErrorMessage:null==e?void 0:e.message})}}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function te(e,t){if(t||e.swRegistration||await ee(e),t||!e.swRegistration){if(!(t instanceof ServiceWorkerRegistration))throw j.create("invalid-sw-registration");e.swRegistration=t}}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function ne(e,t){t?e.vapidKey=t:e.vapidKey||(e.vapidKey=c)}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function ie(e,t){if(!navigator)throw j.create("only-available-in-window");if('default'===Notification.permission&&await Notification.requestPermission(),'granted'!==Notification.permission)throw j.create("permission-blocked");return await ne(e,null==t?void 0:t.vapidKey),await te(e,null==t?void 0:t.serviceWorkerRegistration),W(e)}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function oe(e,t,n){const i=ae(t);(await e.firebaseDependencies.analyticsProvider.get()).logEvent(i,{message_id:n[p],message_name:n["google.c.a.c_l"],message_time:n["google.c.a.ts"],message_device_time:Math.floor(Date.now()/1e3)})}function ae(e){switch(e){case f.NOTIFICATION_CLICKED:return'notification_open';case f.PUSH_RECEIVED:return'notification_foreground';default:throw new Error}}
/**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function re(e,t){const n=t.data;if(!n.isFirebaseMessaging)return;e.onMessageHandler&&n.messageType===f.PUSH_RECEIVED&&('function'==typeof e.onMessageHandler?e.onMessageHandler(G(n)):e.onMessageHandler.next(G(n)));const i=n.data;var o;'object'==typeof(o=i)&&o&&p in o&&'1'===i["google.c.a.e"]&&await oe(e,n.messageType,i)}const se="@firebase/messaging",ce="0.12.12",de=e=>{const t=new Z(e.getProvider('app').getImmediate(),e.getProvider('installations-internal').getImmediate(),e.getProvider('analytics-internal'));return navigator.serviceWorker.addEventListener('message',e=>re(t,e)),t},ue=e=>{const t=e.getProvider('messaging').getImmediate();return{getToken:e=>ie(t,e)}};
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
async function pe(){try{await(0,n.validateIndexedDBOpenable)()}catch(e){return!1}return'undefined'!=typeof window&&(0,n.isIndexedDBAvailable)()&&(0,n.areCookiesEnabled)()&&'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window&&'fetch'in window&&ServiceWorkerRegistration.prototype.hasOwnProperty('showNotification')&&PushSubscription.prototype.hasOwnProperty('getKey')}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function le(e){if(!navigator)throw j.create("only-available-in-window");return e.swRegistration||await ee(e),$(e)}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */function fe(e,t){if(!navigator)throw j.create("only-available-in-window");return e.onMessageHandler=t,()=>{e.onMessageHandler=null}}
/**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */function ge(e=(0,i.getApp)()){return pe().then(e=>{if(!e)throw j.create("unsupported-browser")},e=>{throw j.create("indexed-db-unsupported")}),(0,i._getProvider)((0,n.getModularInstance)(e),'messaging').getImmediate()}async function we(e,t){return ie(e=(0,n.getModularInstance)(e),t)}function he(e){return le(e=(0,n.getModularInstance)(e))}function be(e,t){return fe(e=(0,n.getModularInstance)(e),t)}(0,i._registerComponent)(new e.Component('messaging',de,"PUBLIC")),(0,i._registerComponent)(new e.Component('messaging-internal',ue,"PRIVATE")),(0,i.registerVersion)(se,ce),(0,i.registerVersion)(se,ce,'esm2017')},879,[880,881,882,883,878]);
__d(function(g,r,i,a,m,_e,d){"use strict";Object.defineProperty(_e,'__esModule',{value:!0}),Object.defineProperty(_e,"deleteInstallations",{enumerable:!0,get:function(){return bt}}),Object.defineProperty(_e,"getId",{enumerable:!0,get:function(){return gt}}),Object.defineProperty(_e,"getInstallations",{enumerable:!0,get:function(){return Ct}}),Object.defineProperty(_e,"getToken",{enumerable:!0,get:function(){return wt}}),Object.defineProperty(_e,"onIdChange",{enumerable:!0,get:function(){return vt}});var t=r(d[0]),e=r(d[1]),n=r(d[2]),o=r(d[3]);const s="@firebase/installations",c="0.6.9",u=1e4,f=`w:${c}`,p='FIS_v2',l='https://firebaseinstallations.googleapis.com/v1',w=36e5,h={"missing-app-config-values":'Missing App configuration value: "{$valueName}"',"not-registered":'Firebase Installation is not registered.',"installation-not-found":'Firebase Installation not found.',"request-failed":'{$requestName} request failed with error "{$serverCode} {$serverStatus}: {$serverMessage}"',"app-offline":'Could not process request. Application offline.',"delete-pending-registration":"Can't delete installation while there is a pending registration request."},y=new n.ErrorFactory('installations','Installations',h);function b(t){return t instanceof n.FirebaseError&&t.code.includes("request-failed")}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */function v({projectId:t}){return`${l}/projects/${t}/installations`}function C(t){return{token:t.token,requestStatus:2,expiresIn:(e=t.expiresIn,Number(e.replace('s','000'))),creationTime:Date.now()};var e}async function S(t,e){const n=(await e.json()).error;return y.create("request-failed",{requestName:t,serverCode:n.code,serverMessage:n.message,serverStatus:n.status})}function I({apiKey:t}){return new Headers({'Content-Type':'application/json',Accept:'application/json','x-goog-api-key':t})}function T(t,{refreshToken:e}){const n=I(t);return n.append('Authorization',k(e)),n}async function j(t){const e=await t();return e.status>=500&&e.status<600?t():e}function k(t){return`${p} ${t}`}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function P({appConfig:t,heartbeatServiceProvider:e},{fid:n}){const o=v(t),s=I(t),c=e.getImmediate({optional:!0});if(c){const t=await c.getHeartbeatsHeader();t&&s.append('x-firebase-client',t)}const u={fid:n,authVersion:p,appId:t.appId,sdkVersion:f},l={method:'POST',headers:s,body:JSON.stringify(u)},w=await j(()=>fetch(o,l));if(w.ok){const t=await w.json();return{fid:t.fid||n,registrationStatus:2,refreshToken:t.refreshToken,authToken:C(t.authToken)}}throw await S('Create Installation',w)}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */function q(t){return new Promise(e=>{setTimeout(e,t)})}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
const O=/^[cdef][\w-]{21}$/,$='';function E(){try{const t=new Uint8Array(17);(self.crypto||self.msCrypto).getRandomValues(t),t[0]=112+t[0]%16;const e=D(t);return O.test(e)?e:$}catch(t){return $}}function D(t){var e;return(e=t,btoa(String.fromCharCode(...e)).replace(/\+/g,'-').replace(/\//g,'_')).substr(0,22)}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */function _(t){return`${t.appName}!${t.appId}`}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */const A=new Map;function N(t,e){const n=_(t);x(n,e),M(n,e)}function F(t,e){L();const n=_(t);let o=A.get(n);o||(o=new Set,A.set(n,o)),o.add(e)}function V(t,e){const n=_(t),o=A.get(n);o&&(o.delete(e),0===o.size&&A.delete(n),B())}function x(t,e){const n=A.get(t);if(n)for(const t of n)t(e)}function M(t,e){const n=L();n&&n.postMessage({key:t,fid:e}),B()}let H=null;function L(){return!H&&'BroadcastChannel'in self&&(H=new BroadcastChannel('[Firebase] FID Change'),H.onmessage=t=>{x(t.data.key,t.data.fid)}),H}function B(){0===A.size&&H&&(H.close(),H=null)}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */const K='firebase-installations-database',z=1,J='firebase-installations-store';let R=null;function U(){return R||(R=(0,o.openDB)(K,z,{upgrade:(t,e)=>{if(0===e)t.createObjectStore(J)}})),R}async function G(t,e){const n=_(t),o=(await U()).transaction(J,'readwrite'),s=o.objectStore(J),c=await s.get(n);return await s.put(e,n),await o.done,c&&c.fid===e.fid||N(t,e.fid),e}async function Q(t){const e=_(t),n=(await U()).transaction(J,'readwrite');await n.objectStore(J).delete(e),await n.done}async function W(t,e){const n=_(t),o=(await U()).transaction(J,'readwrite'),s=o.objectStore(J),c=await s.get(n),u=e(c);return void 0===u?await s.delete(n):await s.put(u,n),await o.done,!u||c&&c.fid===u.fid||N(t,u.fid),u}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function X(t){let e;const n=await W(t.appConfig,n=>{const o=Y(n),s=Z(t,o);return e=s.registrationPromise,s.installationEntry});return n.fid===$?{installationEntry:await e}:{installationEntry:n,registrationPromise:e}}function Y(t){return at(t||{fid:E(),registrationStatus:0})}function Z(t,e){if(0===e.registrationStatus){if(!navigator.onLine){return{installationEntry:e,registrationPromise:Promise.reject(y.create("app-offline"))}}const n={fid:e.fid,registrationStatus:1,registrationTime:Date.now()};return{installationEntry:n,registrationPromise:tt(t,n)}}return 1===e.registrationStatus?{installationEntry:e,registrationPromise:et(t)}:{installationEntry:e}}async function tt(t,e){try{const n=await P(t,e);return G(t.appConfig,n)}catch(n){throw b(n)&&409===n.customData.serverCode?await Q(t.appConfig):await G(t.appConfig,{fid:e.fid,registrationStatus:0}),n}}async function et(t){let e=await nt(t.appConfig);for(;1===e.registrationStatus;)await q(100),e=await nt(t.appConfig);if(0===e.registrationStatus){const{installationEntry:e,registrationPromise:n}=await X(t);return n||e}return e}function nt(t){return W(t,t=>{if(!t)throw y.create("installation-not-found");return at(t)})}function at(t){return 1===(e=t).registrationStatus&&e.registrationTime+u<Date.now()?{fid:t.fid,registrationStatus:0}:t;var e;
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */}async function it({appConfig:t,heartbeatServiceProvider:e},n){const o=rt(t,n),s=T(t,n),c=e.getImmediate({optional:!0});if(c){const t=await c.getHeartbeatsHeader();t&&s.append('x-firebase-client',t)}const u={installation:{sdkVersion:f,appId:t.appId}},p={method:'POST',headers:s,body:JSON.stringify(u)},l=await j(()=>fetch(o,p));if(l.ok){return C(await l.json())}throw await S('Generate Auth Token',l)}function rt(t,{fid:e}){return`${v(t)}/${e}/authTokens:generate`}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function ot(t,e=!1){let n;const o=await W(t.appConfig,o=>{if(!ft(o))throw y.create("not-registered");const s=o.authToken;if(!e&&pt(s))return o;if(1===s.requestStatus)return n=st(t,e),o;{if(!navigator.onLine)throw y.create("app-offline");const e=dt(o);return n=ut(t,e),e}});return n?await n:o.authToken}async function st(t,e){let n=await ct(t.appConfig);for(;1===n.authToken.requestStatus;)await q(100),n=await ct(t.appConfig);const o=n.authToken;return 0===o.requestStatus?ot(t,e):o}function ct(t){return W(t,t=>{if(!ft(t))throw y.create("not-registered");const e=t.authToken;return 1===(n=e).requestStatus&&n.requestTime+u<Date.now()?Object.assign(Object.assign({},t),{authToken:{requestStatus:0}}):t;var n;
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */})}async function ut(t,e){try{const n=await it(t,e),o=Object.assign(Object.assign({},e),{authToken:n});return await G(t.appConfig,o),n}catch(n){if(!b(n)||401!==n.customData.serverCode&&404!==n.customData.serverCode){const n=Object.assign(Object.assign({},e),{authToken:{requestStatus:0}});await G(t.appConfig,n)}else await Q(t.appConfig);throw n}}function ft(t){return void 0!==t&&2===t.registrationStatus}function pt(t){return 2===t.requestStatus&&!lt(t)}function lt(t){const e=Date.now();return e<t.creationTime||t.creationTime+t.expiresIn<e+w}function dt(t){const e={requestStatus:1,requestTime:Date.now()};return Object.assign(Object.assign({},t),{authToken:e})}async function gt(t){const e=t,{installationEntry:n,registrationPromise:o}=await X(e);return o?o.catch(console.error):ot(e).catch(console.error),n.fid}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function wt(t,e=!1){const n=t;await mt(n);return(await ot(n,e)).token}async function mt(t){const{registrationPromise:e}=await X(t);e&&await e}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function ht(t,e){const n=yt(t,e),o={method:'DELETE',headers:T(t,e)},s=await j(()=>fetch(n,o));if(!s.ok)throw await S('Delete Installation',s)}function yt(t,{fid:e}){return`${v(t)}/${e}`}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */async function bt(t){const{appConfig:e}=t,n=await W(e,t=>{if(!t||0!==t.registrationStatus)return t});if(n){if(1===n.registrationStatus)throw y.create("delete-pending-registration");if(2===n.registrationStatus){if(!navigator.onLine)throw y.create("app-offline");await ht(e,n),await Q(e)}}}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */function vt(t,e){const{appConfig:n}=t;return F(n,e),()=>{V(n,e)}}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */function Ct(e=(0,t.getApp)()){return(0,t._getProvider)(e,'installations').getImmediate()}
/**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */function St(t){if(!t||!t.options)throw It('App Configuration');if(!t.name)throw It('App Name');const e=['projectId','apiKey','appId'];for(const n of e)if(!t.options[n])throw It(n);return{appName:t.name,projectId:t.options.projectId,apiKey:t.options.apiKey,appId:t.options.appId}}function It(t){return y.create("missing-app-config-values",{valueName:t})}
/**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */const Tt='installations',jt=e=>{const n=e.getProvider('app').getImmediate();return{app:n,appConfig:St(n),heartbeatServiceProvider:(0,t._getProvider)(n,'heartbeat'),_delete:()=>Promise.resolve()}},kt=e=>{const n=e.getProvider('app').getImmediate(),o=(0,t._getProvider)(n,Tt).getImmediate();return{getId:()=>gt(o),getToken:t=>wt(o,t)}};(0,t._registerComponent)(new e.Component(Tt,jt,"PUBLIC")),(0,t._registerComponent)(new e.Component("installations-internal",kt,"PRIVATE")),(0,t.registerVersion)(s,c),(0,t.registerVersion)(s,c,'esm2017')},880,[878,881,883,882]);