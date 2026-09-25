__d(function(g,r,i,a,m,_e,d){"use strict";Object.defineProperty(_e,'__esModule',{value:!0}),Object.defineProperty(_e,"FirebaseError",{enumerable:!0,get:function(){return n.FirebaseError}}),Object.defineProperty(_e,"SDK_VERSION",{enumerable:!0,get:function(){return ne}}),Object.defineProperty(_e,"_DEFAULT_ENTRY_NAME",{enumerable:!0,get:function(){return L}}),Object.defineProperty(_e,"_addComponent",{enumerable:!0,get:function(){return W}}),Object.defineProperty(_e,"_addOrOverwriteComponent",{enumerable:!0,get:function(){return q}}),Object.defineProperty(_e,"_apps",{enumerable:!0,get:function(){return T}}),Object.defineProperty(_e,"_clearComponents",{enumerable:!0,get:function(){return Z}}),Object.defineProperty(_e,"_components",{enumerable:!0,get:function(){return J}}),Object.defineProperty(_e,"_getProvider",{enumerable:!0,get:function(){return Y}}),Object.defineProperty(_e,"_isFirebaseApp",{enumerable:!0,get:function(){return Q}}),Object.defineProperty(_e,"_isFirebaseServerApp",{enumerable:!0,get:function(){return X}}),Object.defineProperty(_e,"_registerComponent",{enumerable:!0,get:function(){return K}}),Object.defineProperty(_e,"_removeServiceInstance",{enumerable:!0,get:function(){return G}}),Object.defineProperty(_e,"_serverApps",{enumerable:!0,get:function(){return V}}),Object.defineProperty(_e,"deleteApp",{enumerable:!0,get:function(){return le}}),Object.defineProperty(_e,"getApp",{enumerable:!0,get:function(){return se}}),Object.defineProperty(_e,"getApps",{enumerable:!0,get:function(){return ce}}),Object.defineProperty(_e,"initializeApp",{enumerable:!0,get:function(){return ie}}),Object.defineProperty(_e,"initializeServerApp",{enumerable:!0,get:function(){return oe}}),Object.defineProperty(_e,"onLog",{enumerable:!0,get:function(){return pe}}),Object.defineProperty(_e,"registerVersion",{enumerable:!0,get:function(){return fe}}),Object.defineProperty(_e,"setLogLevel",{enumerable:!0,get:function(){return ue}});var e=r(d[0]),t=r(d[1]),n=r(d[2]),o=r(d[3]);
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
class s{constructor(e){this.container=e}getPlatformInfoString(){return this.container.getProviders().map(e=>{if(c(e)){const t=e.getImmediate();return`${t.library}/${t.version}`}return null}).filter(e=>e).join(' ')}}function c(e){const t=e.getComponent();return"VERSION"===(null==t?void 0:t.type)}const l="@firebase/app",f="0.10.13",p=new t.Logger('@firebase/app'),u="@firebase/app-compat",h="@firebase/analytics-compat",b="@firebase/analytics",v="@firebase/app-check-compat",w="@firebase/app-check",y="@firebase/auth",_="@firebase/auth-compat",C="@firebase/database",D="@firebase/data-connect",O="@firebase/database-compat",E="@firebase/functions",P="@firebase/functions-compat",j="@firebase/installations",S="@firebase/installations-compat",I="@firebase/messaging",A="@firebase/messaging-compat",F="@firebase/performance",$="@firebase/performance-compat",N="@firebase/remote-config",R="@firebase/remote-config-compat",k="@firebase/storage",x="@firebase/storage-compat",B="@firebase/firestore",z="@firebase/vertexai-preview",H="@firebase/firestore-compat",M="firebase",L='[DEFAULT]',U={[l]:'fire-core',[u]:'fire-core-compat',[b]:'fire-analytics',[h]:'fire-analytics-compat',[w]:'fire-app-check',[v]:'fire-app-check-compat',[y]:'fire-auth',[_]:'fire-auth-compat',[C]:'fire-rtdb',[D]:'fire-data-connect',[O]:'fire-rtdb-compat',[E]:'fire-fn',[P]:'fire-fn-compat',[j]:'fire-iid',[S]:'fire-iid-compat',[I]:'fire-fcm',[A]:'fire-fcm-compat',[F]:'fire-perf',[$]:'fire-perf-compat',[N]:'fire-rc',[R]:'fire-rc-compat',[k]:'fire-gcs',[x]:'fire-gcs-compat',[B]:'fire-fst',[H]:'fire-fst-compat',[z]:'fire-vertex','fire-js':'fire-js',[M]:'fire-js-all'},T=new Map,V=new Map,J=new Map;function W(e,t){try{e.container.addComponent(t)}catch(n){p.debug(`Component ${t.name} failed to register with FirebaseApp ${e.name}`,n)}}function q(e,t){e.container.addOrOverwriteComponent(t)}function K(e){const t=e.name;if(J.has(t))return p.debug(`There were multiple attempts to register component ${t}.`),!1;J.set(t,e);for(const t of T.values())W(t,e);for(const t of V.values())W(t,e);return!0}function Y(e,t){const n=e.container.getProvider('heartbeat').getImmediate({optional:!0});return n&&n.triggerHeartbeat(),e.container.getProvider(t)}function G(e,t,n=L){Y(e,t).clearInstance(n)}function Q(e){return void 0!==e.options}function X(e){return void 0!==e.settings}function Z(){J.clear()}
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
   */const ee={"no-app":"No Firebase App '{$appName}' has been created - call initializeApp() first","bad-app-name":"Illegal App name: '{$appName}'","duplicate-app":"Firebase App named '{$appName}' already exists with different options or config","app-deleted":"Firebase App named '{$appName}' already deleted","server-app-deleted":'Firebase Server App has been deleted',"no-options":'Need to provide options, when not being deployed to hosting via source.',"invalid-app-argument":"firebase.{$appName}() takes either no argument or a Firebase App instance.","invalid-log-argument":'First argument to `onLog` must be null or a function.',"idb-open":'Error thrown when opening IndexedDB. Original error: {$originalErrorMessage}.',"idb-get":'Error thrown when reading from IndexedDB. Original error: {$originalErrorMessage}.',"idb-set":'Error thrown when writing to IndexedDB. Original error: {$originalErrorMessage}.',"idb-delete":'Error thrown when deleting from IndexedDB. Original error: {$originalErrorMessage}.',"finalization-registry-not-supported":'FirebaseServerApp deleteOnDeref field defined but the JS runtime does not support FinalizationRegistry.',"invalid-server-app-environment":'FirebaseServerApp is not for use in browser environments.'},te=new n.ErrorFactory('app','Firebase',ee);
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
class re{constructor(t,n,o){this._isDeleted=!1,this._options=Object.assign({},t),this._config=Object.assign({},n),this._name=n.name,this._automaticDataCollectionEnabled=n.automaticDataCollectionEnabled,this._container=o,this.container.addComponent(new e.Component('app',()=>this,"PUBLIC"))}get automaticDataCollectionEnabled(){return this.checkDestroyed(),this._automaticDataCollectionEnabled}set automaticDataCollectionEnabled(e){this.checkDestroyed(),this._automaticDataCollectionEnabled=e}get name(){return this.checkDestroyed(),this._name}get options(){return this.checkDestroyed(),this._options}get config(){return this.checkDestroyed(),this._config}get container(){return this._container}get isDeleted(){return this._isDeleted}set isDeleted(e){this._isDeleted=e}checkDestroyed(){if(this.isDeleted)throw te.create("app-deleted",{appName:this._name})}}
/**
   * @license
   * Copyright 2023 Google LLC
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
   */class ae extends re{constructor(e,t,n,o){const s=void 0!==t.automaticDataCollectionEnabled&&t.automaticDataCollectionEnabled,c={name:n,automaticDataCollectionEnabled:s};if(void 0!==e.apiKey)super(e,c,o);else{super(e.options,c,o)}this._serverConfig=Object.assign({automaticDataCollectionEnabled:s},t),this._finalizationRegistry=null,'undefined'!=typeof FinalizationRegistry&&(this._finalizationRegistry=new FinalizationRegistry(()=>{this.automaticCleanup()})),this._refCount=0,this.incRefCount(this._serverConfig.releaseOnDeref),this._serverConfig.releaseOnDeref=void 0,t.releaseOnDeref=void 0,fe(l,f,'serverapp')}toJSON(){}get refCount(){return this._refCount}incRefCount(e){this.isDeleted||(this._refCount++,void 0!==e&&null!==this._finalizationRegistry&&this._finalizationRegistry.register(e,this))}decRefCount(){return this.isDeleted?0:--this._refCount}automaticCleanup(){le(this)}get settings(){return this.checkDestroyed(),this._serverConfig}checkDestroyed(){if(this.isDeleted)throw te.create("server-app-deleted")}}
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
   */const ne="10.14.1";function ie(t,o={}){let s=t;if('object'!=typeof o){o={name:o}}const c=Object.assign({name:L,automaticDataCollectionEnabled:!1},o),l=c.name;if('string'!=typeof l||!l)throw te.create("bad-app-name",{appName:String(l)});if(s||(s=(0,n.getDefaultAppConfig)()),!s)throw te.create("no-options");const f=T.get(l);if(f){if((0,n.deepEqual)(s,f.options)&&(0,n.deepEqual)(c,f.config))return f;throw te.create("duplicate-app",{appName:l})}const p=new e.ComponentContainer(l);for(const e of J.values())p.addComponent(e);const u=new re(s,c,p);return T.set(l,u),u}function oe(t,o){if((0,n.isBrowser)()&&!(0,n.isWebWorker)())throw te.create("invalid-server-app-environment");let s;void 0===o.automaticDataCollectionEnabled&&(o.automaticDataCollectionEnabled=!1),s=Q(t)?t.options:t;const c=Object.assign(Object.assign({},o),s);void 0!==c.releaseOnDeref&&delete c.releaseOnDeref;if(void 0!==o.releaseOnDeref&&'undefined'==typeof FinalizationRegistry)throw te.create("finalization-registry-not-supported",{});const l=''+(f=JSON.stringify(c),[...f].reduce((e,t)=>Math.imul(31,e)+t.charCodeAt(0)|0,0));var f;const p=V.get(l);if(p)return p.incRefCount(o.releaseOnDeref),p;const u=new e.ComponentContainer(l);for(const e of J.values())u.addComponent(e);const h=new ae(s,o,l,u);return V.set(l,h),h}function se(e=L){const t=T.get(e);if(!t&&e===L&&(0,n.getDefaultAppConfig)())return ie();if(!t)throw te.create("no-app",{appName:e});return t}function ce(){return Array.from(T.values())}async function le(e){let t=!1;const n=e.name;if(T.has(n))t=!0,T.delete(n);else if(V.has(n)){e.decRefCount()<=0&&(V.delete(n),t=!0)}t&&(await Promise.all(e.container.getProviders().map(e=>e.delete())),e.isDeleted=!0)}function fe(t,n,o){var s;let c=null!==(s=U[t])&&void 0!==s?s:t;o&&(c+=`-${o}`);const l=c.match(/\s|\//),f=n.match(/\s|\//);if(l||f){const e=[`Unable to register library "${c}" with version "${n}":`];return l&&e.push(`library name "${c}" contains illegal characters (whitespace or "/")`),l&&f&&e.push('and'),f&&e.push(`version name "${n}" contains illegal characters (whitespace or "/")`),void p.warn(e.join(' '))}K(new e.Component(`${c}-version`,()=>({library:c,version:n}),"VERSION"))}function pe(e,n){if(null!==e&&'function'!=typeof e)throw te.create("invalid-log-argument");(0,t.setUserLogHandler)(e,n)}function ue(e){(0,t.setLogLevel)(e)}
/**
   * @license
   * Copyright 2021 Google LLC
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
   */const he='firebase-heartbeat-store';let de=null;function be(){return de||(de=(0,o.openDB)("firebase-heartbeat-database",1,{upgrade:(e,t)=>{if(0===t)try{e.createObjectStore(he)}catch(e){console.warn(e)}}}).catch(e=>{throw te.create("idb-open",{originalErrorMessage:e.message})})),de}async function ge(e){try{const t=(await be()).transaction(he),n=await t.objectStore(he).get(ve(e));return await t.done,n}catch(e){if(e instanceof n.FirebaseError)p.warn(e.message);else{const t=te.create("idb-get",{originalErrorMessage:null==e?void 0:e.message});p.warn(t.message)}}}async function me(e,t){try{const n=(await be()).transaction(he,'readwrite'),o=n.objectStore(he);await o.put(t,ve(e)),await n.done}catch(e){if(e instanceof n.FirebaseError)p.warn(e.message);else{const t=te.create("idb-set",{originalErrorMessage:null==e?void 0:e.message});p.warn(t.message)}}}function ve(e){return`${e.name}!${e.options.appId}`}
/**
   * @license
   * Copyright 2021 Google LLC
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
   */class we{constructor(e){this.container=e,this._heartbeatsCache=null;const t=this.container.getProvider('app').getImmediate();this._storage=new De(t),this._heartbeatsCachePromise=this._storage.read().then(e=>(this._heartbeatsCache=e,e))}async triggerHeartbeat(){var e,t;try{const n=this.container.getProvider('platform-logger').getImmediate().getPlatformInfoString(),o=ye();if(null==(null===(e=this._heartbeatsCache)||void 0===e?void 0:e.heartbeats)&&(this._heartbeatsCache=await this._heartbeatsCachePromise,null==(null===(t=this._heartbeatsCache)||void 0===t?void 0:t.heartbeats)))return;if(this._heartbeatsCache.lastSentHeartbeatDate===o||this._heartbeatsCache.heartbeats.some(e=>e.date===o))return;return this._heartbeatsCache.heartbeats.push({date:o,agent:n}),this._heartbeatsCache.heartbeats=this._heartbeatsCache.heartbeats.filter(e=>{const t=new Date(e.date).valueOf();return Date.now()-t<=2592e6}),this._storage.overwrite(this._heartbeatsCache)}catch(e){p.warn(e)}}async getHeartbeatsHeader(){var e;try{if(null===this._heartbeatsCache&&await this._heartbeatsCachePromise,null==(null===(e=this._heartbeatsCache)||void 0===e?void 0:e.heartbeats)||0===this._heartbeatsCache.heartbeats.length)return'';const t=ye(),{heartbeatsToSend:o,unsentEntries:s}=Ce(this._heartbeatsCache.heartbeats),c=(0,n.base64urlEncodeWithoutPadding)(JSON.stringify({version:2,heartbeats:o}));return this._heartbeatsCache.lastSentHeartbeatDate=t,s.length>0?(this._heartbeatsCache.heartbeats=s,await this._storage.overwrite(this._heartbeatsCache)):(this._heartbeatsCache.heartbeats=[],this._storage.overwrite(this._heartbeatsCache)),c}catch(e){return p.warn(e),''}}}function ye(){return(new Date).toISOString().substring(0,10)}function Ce(e,t=1024){const n=[];let o=e.slice();for(const s of e){const e=n.find(e=>e.agent===s.agent);if(e){if(e.dates.push(s.date),Oe(n)>t){e.dates.pop();break}}else if(n.push({agent:s.agent,dates:[s.date]}),Oe(n)>t){n.pop();break}o=o.slice(1)}return{heartbeatsToSend:n,unsentEntries:o}}class De{constructor(e){this.app=e,this._canUseIndexedDBPromise=this.runIndexedDBEnvironmentCheck()}async runIndexedDBEnvironmentCheck(){return!!(0,n.isIndexedDBAvailable)()&&(0,n.validateIndexedDBOpenable)().then(()=>!0).catch(()=>!1)}async read(){if(await this._canUseIndexedDBPromise){const e=await ge(this.app);return(null==e?void 0:e.heartbeats)?e:{heartbeats:[]}}return{heartbeats:[]}}async overwrite(e){var t;if(await this._canUseIndexedDBPromise){const n=await this.read();return me(this.app,{lastSentHeartbeatDate:null!==(t=e.lastSentHeartbeatDate)&&void 0!==t?t:n.lastSentHeartbeatDate,heartbeats:e.heartbeats})}}async add(e){var t;if(await this._canUseIndexedDBPromise){const n=await this.read();return me(this.app,{lastSentHeartbeatDate:null!==(t=e.lastSentHeartbeatDate)&&void 0!==t?t:n.lastSentHeartbeatDate,heartbeats:[...n.heartbeats,...e.heartbeats]})}}}function Oe(e){return(0,n.base64urlEncodeWithoutPadding)(JSON.stringify({version:2,heartbeats:e})).length}
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
   */var Ee;Ee='',K(new e.Component('platform-logger',e=>new s(e),"PRIVATE")),K(new e.Component('heartbeat',e=>new we(e),"PRIVATE")),fe(l,f,Ee),fe(l,f,'esm2017'),fe('fire-js','')},868,[871,874,873,872]);
__d(function(g,r,i,a,m,_e,d){"use strict";Object.defineProperty(_e,'__esModule',{value:!0}),Object.defineProperty(_e,"Component",{enumerable:!0,get:function(){return t}}),Object.defineProperty(_e,"ComponentContainer",{enumerable:!0,get:function(){return c}}),Object.defineProperty(_e,"Provider",{enumerable:!0,get:function(){return s}});var e=r(d[0]);class t{constructor(e,t,n){this.name=e,this.instanceFactory=t,this.type=n,this.multipleInstances=!1,this.serviceProps={},this.instantiationMode="LAZY",this.onInstanceCreated=null}setInstantiationMode(e){return this.instantiationMode=e,this}setMultipleInstances(e){return this.multipleInstances=e,this}setServiceProps(e){return this.serviceProps=e,this}setInstanceCreatedCallback(e){return this.onInstanceCreated=e,this}}
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
   */const n='[DEFAULT]';
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
   */class s{constructor(e,t){this.name=e,this.container=t,this.component=null,this.instances=new Map,this.instancesDeferred=new Map,this.instancesOptions=new Map,this.onInitCallbacks=new Map}get(t){const n=this.normalizeInstanceIdentifier(t);if(!this.instancesDeferred.has(n)){const t=new e.Deferred;if(this.instancesDeferred.set(n,t),this.isInitialized(n)||this.shouldAutoInitialize())try{const e=this.getOrInitializeService({instanceIdentifier:n});e&&t.resolve(e)}catch(e){}}return this.instancesDeferred.get(n).promise}getImmediate(e){var t;const n=this.normalizeInstanceIdentifier(null==e?void 0:e.identifier),s=null!==(t=null==e?void 0:e.optional)&&void 0!==t&&t;if(!this.isInitialized(n)&&!this.shouldAutoInitialize()){if(s)return null;throw Error(`Service ${this.name} is not available`)}try{return this.getOrInitializeService({instanceIdentifier:n})}catch(e){if(s)return null;throw e}}getComponent(){return this.component}setComponent(e){if(e.name!==this.name)throw Error(`Mismatching Component ${e.name} for Provider ${this.name}.`);if(this.component)throw Error(`Component for ${this.name} has already been provided`);if(this.component=e,this.shouldAutoInitialize()){if(o(e))try{this.getOrInitializeService({instanceIdentifier:n})}catch(e){}for(const[e,t]of this.instancesDeferred.entries()){const n=this.normalizeInstanceIdentifier(e);try{const e=this.getOrInitializeService({instanceIdentifier:n});t.resolve(e)}catch(e){}}}}clearInstance(e=n){this.instancesDeferred.delete(e),this.instancesOptions.delete(e),this.instances.delete(e)}async delete(){const e=Array.from(this.instances.values());await Promise.all([...e.filter(e=>'INTERNAL'in e).map(e=>e.INTERNAL.delete()),...e.filter(e=>'_delete'in e).map(e=>e._delete())])}isComponentSet(){return null!=this.component}isInitialized(e=n){return this.instances.has(e)}getOptions(e=n){return this.instancesOptions.get(e)||{}}initialize(e={}){const{options:t={}}=e,n=this.normalizeInstanceIdentifier(e.instanceIdentifier);if(this.isInitialized(n))throw Error(`${this.name}(${n}) has already been initialized`);if(!this.isComponentSet())throw Error(`Component ${this.name} has not been registered yet`);const s=this.getOrInitializeService({instanceIdentifier:n,options:t});for(const[e,t]of this.instancesDeferred.entries()){n===this.normalizeInstanceIdentifier(e)&&t.resolve(s)}return s}onInit(e,t){var n;const s=this.normalizeInstanceIdentifier(t),o=null!==(n=this.onInitCallbacks.get(s))&&void 0!==n?n:new Set;o.add(e),this.onInitCallbacks.set(s,o);const c=this.instances.get(s);return c&&e(c,s),()=>{o.delete(e)}}invokeOnInitCallbacks(e,t){const n=this.onInitCallbacks.get(t);if(n)for(const s of n)try{s(e,t)}catch(e){}}getOrInitializeService({instanceIdentifier:e,options:t={}}){let s=this.instances.get(e);if(!s&&this.component&&(s=this.component.instanceFactory(this.container,{instanceIdentifier:(o=e,o===n?void 0:o),options:t}),this.instances.set(e,s),this.instancesOptions.set(e,t),this.invokeOnInitCallbacks(s,e),this.component.onInstanceCreated))try{this.component.onInstanceCreated(this.container,e,s)}catch(e){}var o;return s||null}normalizeInstanceIdentifier(e=n){return this.component?this.component.multipleInstances?e:n:e}shouldAutoInitialize(){return!!this.component&&"EXPLICIT"!==this.component.instantiationMode}}function o(e){return"EAGER"===e.instantiationMode}
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
   */class c{constructor(e){this.name=e,this.providers=new Map}addComponent(e){const t=this.getProvider(e.name);if(t.isComponentSet())throw new Error(`Component ${e.name} has already been registered with ${this.name}`);t.setComponent(e)}addOrOverwriteComponent(e){this.getProvider(e.name).isComponentSet()&&this.providers.delete(e.name),this.addComponent(e)}getProvider(e){if(this.providers.has(e))return this.providers.get(e);const t=new s(e,this);return this.providers.set(e,t),t}getProviders(){return Array.from(this.providers.values())}}},871,[873]);
__d(function(g,r,i,a,m,e,d){"use strict";Object.defineProperty(e,'__esModule',{value:!0}),Object.defineProperty(e,"unwrap",{enumerable:!0,get:function(){return n.u}}),Object.defineProperty(e,"wrap",{enumerable:!0,get:function(){return n.w}}),Object.defineProperty(e,"deleteDB",{enumerable:!0,get:function(){return o}}),Object.defineProperty(e,"openDB",{enumerable:!0,get:function(){return t}});var n=r(d[0]);function t(t,o,{blocked:s,upgrade:c,blocking:u,terminated:l}={}){const f=indexedDB.open(t,o),b=(0,n.w)(f);return c&&f.addEventListener('upgradeneeded',t=>{c((0,n.w)(f.result),t.oldVersion,t.newVersion,(0,n.w)(f.transaction),t)}),s&&f.addEventListener('blocked',n=>s(n.oldVersion,n.newVersion,n)),b.then(n=>{l&&n.addEventListener('close',()=>l()),u&&n.addEventListener('versionchange',n=>u(n.oldVersion,n.newVersion,n))}).catch(()=>{}),b}function o(t,{blocked:o}={}){const s=indexedDB.deleteDatabase(t);return o&&s.addEventListener('blocked',n=>o(n.oldVersion,n)),(0,n.w)(s).then(()=>{})}const s=['get','getKey','getAll','getAllKeys','count'],c=['put','add','delete','clear'],u=new Map;function l(n,t){if(!(n instanceof IDBDatabase)||t in n||'string'!=typeof t)return;if(u.get(t))return u.get(t);const o=t.replace(/FromIndex$/,''),l=t!==o,f=c.includes(o);if(!(o in(l?IDBIndex:IDBObjectStore).prototype)||!f&&!s.includes(o))return;const b=async function(n,...t){const s=this.transaction(n,f?'readwrite':'readonly');let c=s.store;return l&&(c=c.index(t.shift())),(await Promise.all([c[o](...t),f&&s.done]))[0]};return u.set(t,b),b}(0,n.r)(n=>Object.assign({},n,{get:(t,o,s)=>l(t,o)||n.get(t,o,s),has:(t,o)=>!!l(t,o)||n.has(t,o)}))},872,[875]);
__d(function(g,_r,_i,_a2,m,_e,_d){"use strict";Object.defineProperty(_e,'__esModule',{value:!0}),Object.defineProperty(_e,"CONSTANTS",{enumerable:!0,get:function(){return e}}),Object.defineProperty(_e,"DecodeBase64StringError",{enumerable:!0,get:function(){return s}}),Object.defineProperty(_e,"Deferred",{enumerable:!0,get:function(){return j}}),Object.defineProperty(_e,"ErrorFactory",{enumerable:!0,get:function(){return V}}),Object.defineProperty(_e,"FirebaseError",{enumerable:!0,get:function(){return F}}),Object.defineProperty(_e,"MAX_VALUE_MILLIS",{enumerable:!0,get:function(){return Se}}),Object.defineProperty(_e,"RANDOM_FACTOR",{enumerable:!0,get:function(){return Ae}}),Object.defineProperty(_e,"Sha1",{enumerable:!0,get:function(){return ue}}),Object.defineProperty(_e,"areCookiesEnabled",{enumerable:!0,get:function(){return U}}),Object.defineProperty(_e,"assert",{enumerable:!0,get:function(){return t}}),Object.defineProperty(_e,"assertionError",{enumerable:!0,get:function(){return r}}),Object.defineProperty(_e,"async",{enumerable:!0,get:function(){return le}}),Object.defineProperty(_e,"base64",{enumerable:!0,get:function(){return i}}),Object.defineProperty(_e,"base64Decode",{enumerable:!0,get:function(){return a}}),Object.defineProperty(_e,"base64Encode",{enumerable:!0,get:function(){return c}}),Object.defineProperty(_e,"base64urlEncodeWithoutPadding",{enumerable:!0,get:function(){return u}}),Object.defineProperty(_e,"calculateBackoffMillis",{enumerable:!0,get:function(){return Ce}}),Object.defineProperty(_e,"contains",{enumerable:!0,get:function(){return Y}}),Object.defineProperty(_e,"createMockUserToken",{enumerable:!0,get:function(){return P}}),Object.defineProperty(_e,"createSubscribe",{enumerable:!0,get:function(){return ae}}),Object.defineProperty(_e,"decode",{enumerable:!0,get:function(){return G}}),Object.defineProperty(_e,"deepCopy",{enumerable:!0,get:function(){return f}}),Object.defineProperty(_e,"deepEqual",{enumerable:!0,get:function(){return re}}),Object.defineProperty(_e,"deepExtend",{enumerable:!0,get:function(){return l}}),Object.defineProperty(_e,"errorPrefix",{enumerable:!0,get:function(){return pe}}),Object.defineProperty(_e,"extractQuerystring",{enumerable:!0,get:function(){return ce}}),Object.defineProperty(_e,"getDefaultAppConfig",{enumerable:!0,get:function(){return E}}),Object.defineProperty(_e,"getDefaultEmulatorHost",{enumerable:!0,get:function(){return O}}),Object.defineProperty(_e,"getDefaultEmulatorHostnameAndPort",{enumerable:!0,get:function(){return _}}),Object.defineProperty(_e,"getDefaults",{enumerable:!0,get:function(){return y}}),Object.defineProperty(_e,"getExperimentalSetting",{enumerable:!0,get:function(){return v}}),Object.defineProperty(_e,"getGlobal",{enumerable:!0,get:function(){return d}}),Object.defineProperty(_e,"getModularInstance",{enumerable:!0,get:function(){return De}}),Object.defineProperty(_e,"getUA",{enumerable:!0,get:function(){return S}}),Object.defineProperty(_e,"isAdmin",{enumerable:!0,get:function(){return X}}),Object.defineProperty(_e,"isBrowser",{enumerable:!0,get:function(){return w}}),Object.defineProperty(_e,"isBrowserExtension",{enumerable:!0,get:function(){return T}}),Object.defineProperty(_e,"isCloudflareWorker",{enumerable:!0,get:function(){return D}}),Object.defineProperty(_e,"isElectron",{enumerable:!0,get:function(){return k}}),Object.defineProperty(_e,"isEmpty",{enumerable:!0,get:function(){return ee}}),Object.defineProperty(_e,"isIE",{enumerable:!0,get:function(){return M}}),Object.defineProperty(_e,"isIndexedDBAvailable",{enumerable:!0,get:function(){return L}}),Object.defineProperty(_e,"isMobileCordova",{enumerable:!0,get:function(){return A}}),Object.defineProperty(_e,"isNode",{enumerable:!0,get:function(){return C}}),Object.defineProperty(_e,"isNodeSdk",{enumerable:!0,get:function(){return I}}),Object.defineProperty(_e,"isReactNative",{enumerable:!0,get:function(){return N}}),Object.defineProperty(_e,"isSafari",{enumerable:!0,get:function(){return W}}),Object.defineProperty(_e,"isUWP",{enumerable:!0,get:function(){return B}}),Object.defineProperty(_e,"isValidFormat",{enumerable:!0,get:function(){return Q}}),Object.defineProperty(_e,"isValidTimestamp",{enumerable:!0,get:function(){return q}}),Object.defineProperty(_e,"isWebWorker",{enumerable:!0,get:function(){return x}}),Object.defineProperty(_e,"issuedAtTime",{enumerable:!0,get:function(){return K}}),Object.defineProperty(_e,"jsonEval",{enumerable:!0,get:function(){return J}}),Object.defineProperty(_e,"map",{enumerable:!0,get:function(){return te}}),Object.defineProperty(_e,"ordinal",{enumerable:!0,get:function(){return we}}),Object.defineProperty(_e,"promiseWithTimeout",{enumerable:!0,get:function(){return oe}}),Object.defineProperty(_e,"querystring",{enumerable:!0,get:function(){return ie}}),Object.defineProperty(_e,"querystringDecode",{enumerable:!0,get:function(){return se}}),Object.defineProperty(_e,"safeGet",{enumerable:!0,get:function(){return Z}}),Object.defineProperty(_e,"stringLength",{enumerable:!0,get:function(){return Ee}}),Object.defineProperty(_e,"stringToByteArray",{enumerable:!0,get:function(){return Oe}}),Object.defineProperty(_e,"stringify",{enumerable:!0,get:function(){return H}}),Object.defineProperty(_e,"uuidv4",{enumerable:!0,get:function(){return ve}}),Object.defineProperty(_e,"validateArgCount",{enumerable:!0,get:function(){return be}}),Object.defineProperty(_e,"validateCallback",{enumerable:!0,get:function(){return ge}}),Object.defineProperty(_e,"validateContextObject",{enumerable:!0,get:function(){return me}}),Object.defineProperty(_e,"validateIndexedDBOpenable",{enumerable:!0,get:function(){return R}}),Object.defineProperty(_e,"validateNamespace",{enumerable:!0,get:function(){return ye}});
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
const e={NODE_CLIENT:!1,NODE_ADMIN:!1,SDK_VERSION:'${JSCORE_VERSION}'},t=function(e,t){if(!e)throw r(t)},r=function(t){return new Error('Firebase Database ('+e.SDK_VERSION+') INTERNAL ASSERT FAILED: '+t)},n=function(e){const t=[];let r=0;for(let n=0;n<e.length;n++){let o=e.charCodeAt(n);o<128?t[r++]=o:o<2048?(t[r++]=o>>6|192,t[r++]=63&o|128):55296==(64512&o)&&n+1<e.length&&56320==(64512&e.charCodeAt(n+1))?(o=65536+((1023&o)<<10)+(1023&e.charCodeAt(++n)),t[r++]=o>>18|240,t[r++]=o>>12&63|128,t[r++]=o>>6&63|128,t[r++]=63&o|128):(t[r++]=o>>12|224,t[r++]=o>>6&63|128,t[r++]=63&o|128)}return t},o=function(e){const t=[];let r=0,n=0;for(;r<e.length;){const o=e[r++];if(o<128)t[n++]=String.fromCharCode(o);else if(o>191&&o<224){const i=e[r++];t[n++]=String.fromCharCode((31&o)<<6|63&i)}else if(o>239&&o<365){const i=((7&o)<<18|(63&e[r++])<<12|(63&e[r++])<<6|63&e[r++])-65536;t[n++]=String.fromCharCode(55296+(i>>10)),t[n++]=String.fromCharCode(56320+(1023&i))}else{const i=e[r++],s=e[r++];t[n++]=String.fromCharCode((15&o)<<12|(63&i)<<6|63&s)}}return t.join('')},i={byteToCharMap_:null,charToByteMap_:null,byteToCharMapWebSafe_:null,charToByteMapWebSafe_:null,ENCODED_VALS_BASE:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",get ENCODED_VALS(){return this.ENCODED_VALS_BASE+'+/='},get ENCODED_VALS_WEBSAFE(){return this.ENCODED_VALS_BASE+'-_.'},HAS_NATIVE_SUPPORT:'function'==typeof atob,encodeByteArray(e,t){if(!Array.isArray(e))throw Error('encodeByteArray takes an array as a parameter');this.init_();const r=t?this.byteToCharMapWebSafe_:this.byteToCharMap_,n=[];for(let t=0;t<e.length;t+=3){const o=e[t],i=t+1<e.length,s=i?e[t+1]:0,c=t+2<e.length,u=c?e[t+2]:0,a=o>>2,f=(3&o)<<4|s>>4;let l=(15&s)<<2|u>>6,h=63&u;c||(h=64,i||(l=64)),n.push(r[a],r[f],r[l],r[h])}return n.join('')},encodeString(e,t){return this.HAS_NATIVE_SUPPORT&&!t?btoa(e):this.encodeByteArray(n(e),t)},decodeString(e,t){return this.HAS_NATIVE_SUPPORT&&!t?atob(e):o(this.decodeStringToByteArray(e,t))},decodeStringToByteArray(e,t){this.init_();const r=t?this.charToByteMapWebSafe_:this.charToByteMap_,n=[];for(let t=0;t<e.length;){const o=r[e.charAt(t++)],i=t<e.length?r[e.charAt(t)]:0;++t;const c=t<e.length?r[e.charAt(t)]:64;++t;const u=t<e.length?r[e.charAt(t)]:64;if(++t,null==o||null==i||null==c||null==u)throw new s;const a=o<<2|i>>4;if(n.push(a),64!==c){const e=i<<4&240|c>>2;if(n.push(e),64!==u){const e=c<<6&192|u;n.push(e)}}}return n},init_(){if(!this.byteToCharMap_){this.byteToCharMap_={},this.charToByteMap_={},this.byteToCharMapWebSafe_={},this.charToByteMapWebSafe_={};for(let e=0;e<this.ENCODED_VALS.length;e++)this.byteToCharMap_[e]=this.ENCODED_VALS.charAt(e),this.charToByteMap_[this.byteToCharMap_[e]]=e,this.byteToCharMapWebSafe_[e]=this.ENCODED_VALS_WEBSAFE.charAt(e),this.charToByteMapWebSafe_[this.byteToCharMapWebSafe_[e]]=e,e>=this.ENCODED_VALS_BASE.length&&(this.charToByteMap_[this.ENCODED_VALS_WEBSAFE.charAt(e)]=e,this.charToByteMapWebSafe_[this.ENCODED_VALS.charAt(e)]=e)}}};
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
   */class s extends Error{constructor(){super(...arguments),this.name='DecodeBase64StringError'}}const c=function(e){const t=n(e);return i.encodeByteArray(t,!0)},u=function(e){return c(e).replace(/\./g,'')},a=function(e){try{return i.decodeString(e,!0)}catch(e){console.error('base64Decode failed: ',e)}return null};
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
function f(e){return l(void 0,e)}function l(e,t){if(!(t instanceof Object))return t;switch(t.constructor){case Date:return new Date(t.getTime());case Object:void 0===e&&(e={});break;case Array:e=[];break;default:return t}for(const r in t)t.hasOwnProperty(r)&&h(r)&&(e[r]=l(e[r],t[r]));return e}function h(e){return'__proto__'!==e}
/**
   * @license
   * Copyright 2022 Google LLC
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
   */function d(){if('undefined'!=typeof self)return self;if('undefined'!=typeof window)return window;if(void 0!==g)return g;throw new Error('Unable to locate global object.')}
/**
   * @license
   * Copyright 2022 Google LLC
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
   */const b=()=>{if('undefined'==typeof process||void 0===process.env)return;const e=process.env.__FIREBASE_DEFAULTS__;return e?JSON.parse(e):void 0},p=()=>{if('undefined'==typeof document)return;let e;try{e=document.cookie.match(/__FIREBASE_DEFAULTS__=([^;]+)/)}catch(e){return}const t=e&&a(e[1]);return t&&JSON.parse(t)},y=()=>{try{return d().__FIREBASE_DEFAULTS__||b()||p()}catch(e){return void console.info(`Unable to get __FIREBASE_DEFAULTS__ due to: ${e}`)}},O=e=>{var t,r;return null===(r=null===(t=y())||void 0===t?void 0:t.emulatorHosts)||void 0===r?void 0:r[e]},_=e=>{const t=O(e);if(!t)return;const r=t.lastIndexOf(':');if(r<=0||r+1===t.length)throw new Error(`Invalid host ${t} with no separate hostname and port!`);const n=parseInt(t.substring(r+1),10);return'['===t[0]?[t.substring(1,r-1),n]:[t.substring(0,r),n]},E=()=>{var e;return null===(e=y())||void 0===e?void 0:e.config},v=e=>{var t;return null===(t=y())||void 0===t?void 0:t[`_${e}`]};
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
class j{constructor(){this.reject=()=>{},this.resolve=()=>{},this.promise=new Promise((e,t)=>{this.resolve=e,this.reject=t})}wrapCallback(e){return(t,r)=>{t?this.reject(t):this.resolve(r),'function'==typeof e&&(this.promise.catch(()=>{}),1===e.length?e(t):e(t,r))}}}
/**
   * @license
   * Copyright 2021 Google LLC
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
   */function P(e,t){if(e.uid)throw new Error('The "uid" field is no longer supported by mockUserToken. Please use "sub" instead for Firebase Auth User ID.');const r=t||'demo-project',n=e.iat||0,o=e.sub||e.user_id;if(!o)throw new Error("mockUserToken must contain 'sub' or 'user_id' field!");const i=Object.assign({iss:`https://securetoken.google.com/${r}`,aud:r,iat:n,exp:n+3600,auth_time:n,sub:o,user_id:o,firebase:{sign_in_provider:'custom',identities:{}}},e);return[u(JSON.stringify({alg:'none',type:'JWT'})),u(JSON.stringify(i)),''].join('.')}
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
   */function S(){return'undefined'!=typeof navigator&&'string'==typeof navigator.userAgent?navigator.userAgent:''}function A(){return'undefined'!=typeof window&&!!(window.cordova||window.phonegap||window.PhoneGap)&&/ios|iphone|ipod|ipad|android|blackberry|iemobile/i.test(S())}function C(){var e;const t=null===(e=y())||void 0===e?void 0:e.forceEnvironment;if('node'===t)return!0;if('browser'===t)return!1;try{return'[object process]'===Object.prototype.toString.call(g.process)}catch(e){return!1}}function w(){return'undefined'!=typeof window||x()}function x(){return'undefined'!=typeof WorkerGlobalScope&&'undefined'!=typeof self&&self instanceof WorkerGlobalScope}function D(){return'undefined'!=typeof navigator&&'Cloudflare-Workers'===navigator.userAgent}function T(){const e='object'==typeof chrome?chrome.runtime:'object'==typeof browser?browser.runtime:void 0;return'object'==typeof e&&void 0!==e.id}function N(){return'object'==typeof navigator&&'ReactNative'===navigator.product}function k(){return S().indexOf('Electron/')>=0}function M(){const e=S();return e.indexOf('MSIE ')>=0||e.indexOf('Trident/')>=0}function B(){return S().indexOf('MSAppHost/')>=0}function I(){return!0===e.NODE_CLIENT||!0===e.NODE_ADMIN}function W(){return!C()&&!!navigator.userAgent&&navigator.userAgent.includes('Safari')&&!navigator.userAgent.includes('Chrome')}function L(){try{return'object'==typeof indexedDB}catch(e){return!1}}function R(){return new Promise((e,t)=>{try{let r=!0;const n='validate-browser-context-for-indexeddb-analytics-module',o=self.indexedDB.open(n);o.onsuccess=()=>{o.result.close(),r||self.indexedDB.deleteDatabase(n),e(!0)},o.onupgradeneeded=()=>{r=!1},o.onerror=()=>{var e;t((null===(e=o.error)||void 0===e?void 0:e.message)||'')}}catch(e){t(e)}})}function U(){return!('undefined'==typeof navigator||!navigator.cookieEnabled)}
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
   */class F extends Error{constructor(e,t,r){super(t),this.code=e,this.customData=r,this.name="FirebaseError",Object.setPrototypeOf(this,F.prototype),Error.captureStackTrace&&Error.captureStackTrace(this,V.prototype.create)}}class V{constructor(e,t,r){this.service=e,this.serviceName=t,this.errors=r}create(e,...t){const r=t[0]||{},n=`${this.service}/${e}`,o=this.errors[e],i=o?$(o,r):'Error',s=`${this.serviceName}: ${i} (${n}).`;return new F(n,s,r)}}function $(e,t){return e.replace(z,(e,r)=>{const n=t[r];return null!=n?String(n):`<${r}?>`})}const z=/\{\$([^}]+)}/g;
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
   */function J(e){return JSON.parse(e)}function H(e){return JSON.stringify(e)}
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
   */const G=function(e){let t={},r={},n={},o='';try{const i=e.split('.');t=J(a(i[0])||''),r=J(a(i[1])||''),o=i[2],n=r.d||{},delete r.d}catch(e){}return{header:t,claims:r,data:n,signature:o}},q=function(e){const t=G(e).claims,r=Math.floor((new Date).getTime()/1e3);let n=0,o=0;return'object'==typeof t&&(t.hasOwnProperty('nbf')?n=t.nbf:t.hasOwnProperty('iat')&&(n=t.iat),o=t.hasOwnProperty('exp')?t.exp:n+86400),!!r&&!!n&&!!o&&r>=n&&r<=o},K=function(e){const t=G(e).claims;return'object'==typeof t&&t.hasOwnProperty('iat')?t.iat:null},Q=function(e){const t=G(e).claims;return!!t&&'object'==typeof t&&t.hasOwnProperty('iat')},X=function(e){const t=G(e).claims;return'object'==typeof t&&!0===t.admin};
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
function Y(e,t){return Object.prototype.hasOwnProperty.call(e,t)}function Z(e,t){return Object.prototype.hasOwnProperty.call(e,t)?e[t]:void 0}function ee(e){for(const t in e)if(Object.prototype.hasOwnProperty.call(e,t))return!1;return!0}function te(e,t,r){const n={};for(const o in e)Object.prototype.hasOwnProperty.call(e,o)&&(n[o]=t.call(r,e[o],o,e));return n}function re(e,t){if(e===t)return!0;const r=Object.keys(e),n=Object.keys(t);for(const o of r){if(!n.includes(o))return!1;const r=e[o],i=t[o];if(ne(r)&&ne(i)){if(!re(r,i))return!1}else if(r!==i)return!1}for(const e of n)if(!r.includes(e))return!1;return!0}function ne(e){return null!==e&&'object'==typeof e}
/**
   * @license
   * Copyright 2022 Google LLC
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
   */function oe(e,t=2e3){const r=new j;return setTimeout(()=>r.reject('timeout!'),t),e.then(r.resolve,r.reject),r.promise}
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
   */function ie(e){const t=[];for(const[r,n]of Object.entries(e))Array.isArray(n)?n.forEach(e=>{t.push(encodeURIComponent(r)+'='+encodeURIComponent(e))}):t.push(encodeURIComponent(r)+'='+encodeURIComponent(n));return t.length?'&'+t.join('&'):''}function se(e){const t={};return e.replace(/^\?/,'').split('&').forEach(e=>{if(e){const[r,n]=e.split('=');t[decodeURIComponent(r)]=decodeURIComponent(n)}}),t}function ce(e){const t=e.indexOf('?');if(!t)return'';const r=e.indexOf('#',t);return e.substring(t,r>0?r:void 0)}
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
   */class ue{constructor(){this.chain_=[],this.buf_=[],this.W_=[],this.pad_=[],this.inbuf_=0,this.total_=0,this.blockSize=64,this.pad_[0]=128;for(let e=1;e<this.blockSize;++e)this.pad_[e]=0;this.reset()}reset(){this.chain_[0]=1732584193,this.chain_[1]=4023233417,this.chain_[2]=2562383102,this.chain_[3]=271733878,this.chain_[4]=3285377520,this.inbuf_=0,this.total_=0}compress_(e,t){t||(t=0);const r=this.W_;if('string'==typeof e)for(let n=0;n<16;n++)r[n]=e.charCodeAt(t)<<24|e.charCodeAt(t+1)<<16|e.charCodeAt(t+2)<<8|e.charCodeAt(t+3),t+=4;else for(let n=0;n<16;n++)r[n]=e[t]<<24|e[t+1]<<16|e[t+2]<<8|e[t+3],t+=4;for(let e=16;e<80;e++){const t=r[e-3]^r[e-8]^r[e-14]^r[e-16];r[e]=4294967295&(t<<1|t>>>31)}let n,o,i=this.chain_[0],s=this.chain_[1],c=this.chain_[2],u=this.chain_[3],a=this.chain_[4];for(let e=0;e<80;e++){e<40?e<20?(n=u^s&(c^u),o=1518500249):(n=s^c^u,o=1859775393):e<60?(n=s&c|u&(s|c),o=2400959708):(n=s^c^u,o=3395469782);const t=(i<<5|i>>>27)+n+a+o+r[e]&4294967295;a=u,u=c,c=4294967295&(s<<30|s>>>2),s=i,i=t}this.chain_[0]=this.chain_[0]+i&4294967295,this.chain_[1]=this.chain_[1]+s&4294967295,this.chain_[2]=this.chain_[2]+c&4294967295,this.chain_[3]=this.chain_[3]+u&4294967295,this.chain_[4]=this.chain_[4]+a&4294967295}update(e,t){if(null==e)return;void 0===t&&(t=e.length);const r=t-this.blockSize;let n=0;const o=this.buf_;let i=this.inbuf_;for(;n<t;){if(0===i)for(;n<=r;)this.compress_(e,n),n+=this.blockSize;if('string'==typeof e){for(;n<t;)if(o[i]=e.charCodeAt(n),++i,++n,i===this.blockSize){this.compress_(o),i=0;break}}else for(;n<t;)if(o[i]=e[n],++i,++n,i===this.blockSize){this.compress_(o),i=0;break}}this.inbuf_=i,this.total_+=t}digest(){const e=[];let t=8*this.total_;this.inbuf_<56?this.update(this.pad_,56-this.inbuf_):this.update(this.pad_,this.blockSize-(this.inbuf_-56));for(let e=this.blockSize-1;e>=56;e--)this.buf_[e]=255&t,t/=256;this.compress_(this.buf_);let r=0;for(let t=0;t<5;t++)for(let n=24;n>=0;n-=8)e[r]=this.chain_[t]>>n&255,++r;return e}}function ae(e,t){const r=new fe(e,t);return r.subscribe.bind(r)}class fe{constructor(e,t){this.observers=[],this.unsubscribes=[],this.observerCount=0,this.task=Promise.resolve(),this.finalized=!1,this.onNoObservers=t,this.task.then(()=>{e(this)}).catch(e=>{this.error(e)})}next(e){this.forEachObserver(t=>{t.next(e)})}error(e){this.forEachObserver(t=>{t.error(e)}),this.close(e)}complete(){this.forEachObserver(e=>{e.complete()}),this.close()}subscribe(e,t,r){let n;if(void 0===e&&void 0===t&&void 0===r)throw new Error('Missing Observer.');n=he(e,['next','error','complete'])?e:{next:e,error:t,complete:r},void 0===n.next&&(n.next=de),void 0===n.error&&(n.error=de),void 0===n.complete&&(n.complete=de);const o=this.unsubscribeOne.bind(this,this.observers.length);return this.finalized&&this.task.then(()=>{try{this.finalError?n.error(this.finalError):n.complete()}catch(e){}}),this.observers.push(n),o}unsubscribeOne(e){void 0!==this.observers&&void 0!==this.observers[e]&&(delete this.observers[e],this.observerCount-=1,0===this.observerCount&&void 0!==this.onNoObservers&&this.onNoObservers(this))}forEachObserver(e){if(!this.finalized)for(let t=0;t<this.observers.length;t++)this.sendOne(t,e)}sendOne(e,t){this.task.then(()=>{if(void 0!==this.observers&&void 0!==this.observers[e])try{t(this.observers[e])}catch(e){'undefined'!=typeof console&&console.error&&console.error(e)}})}close(e){this.finalized||(this.finalized=!0,void 0!==e&&(this.finalError=e),this.task.then(()=>{this.observers=void 0,this.onNoObservers=void 0}))}}function le(e,t){return(...r)=>{Promise.resolve(!0).then(()=>{e(...r)}).catch(e=>{t&&t(e)})}}function he(e,t){if('object'!=typeof e||null===e)return!1;for(const r of t)if(r in e&&'function'==typeof e[r])return!0;return!1}function de(){}
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
   */const be=function(e,t,r,n){let o;if(n<t?o='at least '+t:n>r&&(o=0===r?'none':'no more than '+r),o){throw new Error(e+' failed: Was called with '+n+(1===n?' argument.':' arguments.')+' Expects '+o+'.')}};function pe(e,t){return`${e} failed: ${t} argument `}function ye(e,t,r){if((!r||t)&&'string'!=typeof t)throw new Error(pe(e,'namespace')+'must be a valid firebase namespace.')}function ge(e,t,r,n){if((!n||r)&&'function'!=typeof r)throw new Error(pe(e,t)+'must be a valid function.')}function me(e,t,r,n){if((!n||r)&&('object'!=typeof r||null===r))throw new Error(pe(e,t)+'must be a valid context object.')}
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
   */const Oe=function(e){const r=[];let n=0;for(let o=0;o<e.length;o++){let i=e.charCodeAt(o);if(i>=55296&&i<=56319){const r=i-55296;o++,t(o<e.length,'Surrogate pair missing trail surrogate.');i=65536+(r<<10)+(e.charCodeAt(o)-56320)}i<128?r[n++]=i:i<2048?(r[n++]=i>>6|192,r[n++]=63&i|128):i<65536?(r[n++]=i>>12|224,r[n++]=i>>6&63|128,r[n++]=63&i|128):(r[n++]=i>>18|240,r[n++]=i>>12&63|128,r[n++]=i>>6&63|128,r[n++]=63&i|128)}return r},Ee=function(e){let t=0;for(let r=0;r<e.length;r++){const n=e.charCodeAt(r);n<128?t++:n<2048?t+=2:n>=55296&&n<=56319?(t+=4,r++):t+=3}return t},ve=function(){return'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,e=>{const t=16*Math.random()|0;return('x'===e?t:3&t|8).toString(16)})},je=1e3,Pe=2,Se=144e5,Ae=.5;function Ce(e,t=je,r=Pe){const n=t*Math.pow(r,e),o=Math.round(Ae*n*(Math.random()-.5)*2);return Math.min(Se,n+o)}
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
   */function we(e){return Number.isFinite(e)?e+xe(e):`${e}`}function xe(e){const t=(e=Math.abs(e))%100;if(t>=10&&t<=20)return'th';const r=e%10;return 1===r?'st':2===r?'nd':3===r?'rd':'th'}
/**
   * @license
   * Copyright 2021 Google LLC
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
   */function De(e){return e&&e._delegate?e._delegate:e}},873,[]);
__d(function(g,r,i,a,m,e,d){"use strict";Object.defineProperty(e,'__esModule',{value:!0}),Object.defineProperty(e,"LogLevel",{enumerable:!0,get:function(){return n}}),Object.defineProperty(e,"Logger",{enumerable:!0,get:function(){return h}}),Object.defineProperty(e,"setLogLevel",{enumerable:!0,get:function(){return L}}),Object.defineProperty(e,"setUserLogHandler",{enumerable:!0,get:function(){return f}});
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
const t=[];var n;!(function(t){t[t.DEBUG=0]="DEBUG",t[t.VERBOSE=1]="VERBOSE",t[t.INFO=2]="INFO",t[t.WARN=3]="WARN",t[t.ERROR=4]="ERROR",t[t.SILENT=5]="SILENT"})(n||(n={}));const l={debug:n.DEBUG,verbose:n.VERBOSE,info:n.INFO,warn:n.WARN,error:n.ERROR,silent:n.SILENT},o=n.INFO,s={[n.DEBUG]:'log',[n.VERBOSE]:'log',[n.INFO]:'info',[n.WARN]:'warn',[n.ERROR]:'error'},u=(t,n,...l)=>{if(n<t.logLevel)return;const o=(new Date).toISOString(),u=s[n];if(!u)throw new Error(`Attempted to log a message with an invalid logType (value: ${n})`);console[u](`[${o}]  ${t.name}:`,...l)};class h{constructor(n){this.name=n,this._logLevel=o,this._logHandler=u,this._userLogHandler=null,t.push(this)}get logLevel(){return this._logLevel}set logLevel(t){if(!(t in n))throw new TypeError(`Invalid value "${t}" assigned to \`logLevel\``);this._logLevel=t}setLogLevel(t){this._logLevel='string'==typeof t?l[t]:t}get logHandler(){return this._logHandler}set logHandler(t){if('function'!=typeof t)throw new TypeError('Value assigned to `logHandler` must be a function');this._logHandler=t}get userLogHandler(){return this._userLogHandler}set userLogHandler(t){this._userLogHandler=t}debug(...t){this._userLogHandler&&this._userLogHandler(this,n.DEBUG,...t),this._logHandler(this,n.DEBUG,...t)}log(...t){this._userLogHandler&&this._userLogHandler(this,n.VERBOSE,...t),this._logHandler(this,n.VERBOSE,...t)}info(...t){this._userLogHandler&&this._userLogHandler(this,n.INFO,...t),this._logHandler(this,n.INFO,...t)}warn(...t){this._userLogHandler&&this._userLogHandler(this,n.WARN,...t),this._logHandler(this,n.WARN,...t)}error(...t){this._userLogHandler&&this._userLogHandler(this,n.ERROR,...t),this._logHandler(this,n.ERROR,...t)}}function L(n){t.forEach(t=>{t.setLogLevel(n)})}function f(o,s){for(const u of t){let t=null;s&&s.level&&(t=l[s.level]),u.userLogHandler=null===o?null:(l,s,...u)=>{const h=u.map(t=>{if(null==t)return null;if('string'==typeof t)return t;if('number'==typeof t||'boolean'==typeof t)return t.toString();if(t instanceof Error)return t.message;try{return JSON.stringify(t)}catch(t){return null}}).filter(t=>t).join(' ');s>=(null!=t?t:l.logLevel)&&o({level:n[s].toLowerCase(),message:h,args:u,type:l.name})}}}},874,[]);
__d(function(g,r,i,a,m,e,d){"use strict";Object.defineProperty(e,'__esModule',{value:!0}),Object.defineProperty(e,"a",{enumerable:!0,get:function(){return p}}),Object.defineProperty(e,"i",{enumerable:!0,get:function(){return t}}),Object.defineProperty(e,"r",{enumerable:!0,get:function(){return l}}),Object.defineProperty(e,"u",{enumerable:!0,get:function(){return B}}),Object.defineProperty(e,"w",{enumerable:!0,get:function(){return I}});const t=(t,n)=>n.some(n=>t instanceof n);let n,o;const s=new WeakMap,c=new WeakMap,u=new WeakMap,f=new WeakMap,p=new WeakMap;function b(t){const n=new Promise((n,o)=>{const s=()=>{t.removeEventListener('success',c),t.removeEventListener('error',u)},c=()=>{n(I(t.result)),s()},u=()=>{o(t.error),s()};t.addEventListener('success',c),t.addEventListener('error',u)});return n.then(n=>{n instanceof IDBCursor&&s.set(n,t)}).catch(()=>{}),p.set(n,t),n}function v(t){if(c.has(t))return;const n=new Promise((n,o)=>{const s=()=>{t.removeEventListener('complete',c),t.removeEventListener('error',u),t.removeEventListener('abort',u)},c=()=>{n(),s()},u=()=>{o(t.error||new DOMException('AbortError','AbortError')),s()};t.addEventListener('complete',c),t.addEventListener('error',u),t.addEventListener('abort',u)});c.set(t,n)}let D={get(t,n,o){if(t instanceof IDBTransaction){if('done'===n)return c.get(t);if('objectStoreNames'===n)return t.objectStoreNames||u.get(t);if('store'===n)return o.objectStoreNames[1]?void 0:o.objectStore(o.objectStoreNames[0])}return I(t[n])},set:(t,n,o)=>(t[n]=o,!0),has:(t,n)=>t instanceof IDBTransaction&&('done'===n||'store'===n)||n in t};function l(t){D=t(D)}function y(c){return'function'==typeof c?(f=c)!==IDBDatabase.prototype.transaction||'objectStoreNames'in IDBTransaction.prototype?(o||(o=[IDBCursor.prototype.advance,IDBCursor.prototype.continue,IDBCursor.prototype.continuePrimaryKey])).includes(f)?function(...t){return f.apply(B(this),t),I(s.get(this))}:function(...t){return I(f.apply(B(this),t))}:function(t,...n){const o=f.call(B(this),t,...n);return u.set(o,t.sort?t.sort():[t]),I(o)}:(c instanceof IDBTransaction&&v(c),t(c,n||(n=[IDBDatabase,IDBObjectStore,IDBIndex,IDBCursor,IDBTransaction]))?new Proxy(c,D):c);var f}function I(t){if(t instanceof IDBRequest)return b(t);if(f.has(t))return f.get(t);const n=y(t);return n!==t&&(f.set(t,n),p.set(n,t)),n}const B=t=>p.get(t)},875,[]);