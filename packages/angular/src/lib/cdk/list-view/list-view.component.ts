import { AfterContentInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ContentChild, Directive, DoCheck, ElementRef, EmbeddedViewRef, EventEmitter, forwardRef, Host, HostListener, inject, Inject, InjectionToken, Input, IterableDiffer, IterableDiffers, NgZone, OnDestroy, Output, TemplateRef, ViewChild, ViewContainerRef, ɵisListLikeIterable as isListLikeIterable } from '@angular/core';
import { ItemEventData, KeyedTemplate, LayoutBase, ListView, ObservableArray, profile, View } from '@nativescript/core';

import { extractSingleViewRecursive } from '../../element-registry/registry';
import { NativeScriptDebug } from '../../trace';
import { NgViewTemplate } from '../../view-refs';

const NG_VIEW = '_ngViewRef';

export interface TemplatedItemsHost<T = any> {
  registerTemplate(key: string, template: TemplateRef<T>);
}

export const TEMPLATED_ITEMS_COMPONENT = new InjectionToken<TemplatedItemsHost>('TemplatedItemsComponent');

export class ItemContext<T> {
  constructor(public $implicit?: T, public item?: T, public index?: number, public even?: boolean, public odd?: boolean) {}
}

export class NsTemplatedItem<T> implements NgViewTemplate<{ index: number; data: T }> {
  constructor(private template: TemplateRef<ItemContext<T>>, public location: ViewContainerRef, private onCreate?: (view: View) => void) {}
  create(context?: { index: number; data: T }): View {
    const viewRef = this.location.createEmbeddedView(this.template, context ? this.setupItemContext(context) : new ItemContext());
    viewRef.detach(); // create detached, just beware this doesn't always work and the view might run the first CD anyway.
    const resultView = getItemViewRoot(viewRef);
    resultView[NG_VIEW] = viewRef;
    if (this.onCreate) {
      this.onCreate(resultView);
    }
    return resultView;
  }
  update(view: View, context?: { index: number; data: T }): void {
    const viewRef = this.getEmbeddedViewRef(view);
    this.setupItemContext(context, viewRef);
    viewRef?.detectChanges();
  }
  attach(view: View): void {
    const viewRef = this.getEmbeddedViewRef(view);
    viewRef?.reattach();
    viewRef?.detectChanges();
  }
  detach(view: View): void {
    const viewRef = this.getEmbeddedViewRef(view);
    viewRef?.detach();
  }
  dispose(view: View): void {
    const viewRef = this.getEmbeddedViewRef(view);
    viewRef?.destroy();
  }

  getEmbeddedViewRef(view: View): EmbeddedViewRef<ItemContext<T>> | undefined {
    let viewRef = view[NG_VIEW];

    // Getting angular view from original element (in cases when ProxyViewContainer
    // is used NativeScript internally wraps it in a StackLayout)
    if (!viewRef && view instanceof LayoutBase && view.getChildrenCount() > 0) {
      viewRef = view.getChildAt(0)[NG_VIEW];
    }
    return viewRef;
  }

  isValid(view: View) {
    return !!this.getEmbeddedViewRef(view);
  }

  private setupItemContext({ index, data }: { index: number; data: T }, oldView?: EmbeddedViewRef<ItemContext<T>>): ItemContext<T> {
    const context: ItemContext<T> = oldView ? oldView.context : new ItemContext<T>();
    context.$implicit = data;
    context.item = data;
    context.index = index;
    context.even = index % 2 === 0;
    context.odd = !context.even;
    return context;
  }
}

export interface SetupItemViewArgs<T> {
  view: EmbeddedViewRef<ItemContext<T>>;
  nativeElement: View;
  data: T;
  index: number;
  context: ItemContext<T>;
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'ListView',
  template: `<DetachedContainer>
    <ng-container #loader></ng-container>
  </DetachedContainer>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: TEMPLATED_ITEMS_COMPONENT, useExisting: forwardRef(() => ListViewComponent) }],
})
export class ListViewComponent<T = any> implements DoCheck, OnDestroy, AfterContentInit, TemplatedItemsHost {
  public get nativeElement(): ListView {
    return this.templatedItemsView;
  }

  private readonly _iterableDiffers: IterableDiffers = inject(IterableDiffers);
  private readonly _changeDetectorRef: ChangeDetectorRef = inject(ChangeDetectorRef);
  private readonly _elementRef: ElementRef = inject(ElementRef);

  // I believe this only exists so this can be inherited and people can override it.
  protected templatedItemsView: ListView = this._elementRef.nativeElement;
  protected _items: T[] | ObservableArray<T>;
  protected _differ: IterableDiffer<T>;
  protected _templateMap: Map<string, NsTemplatedItem<T>>;
  protected _viewToTemplate: WeakMap<View, string> = new WeakMap<View, string>();

  @ViewChild('loader', { read: ViewContainerRef, static: true }) loader: ViewContainerRef;

  @Output() public setupItemView = new EventEmitter<SetupItemViewArgs<T>>();

  @ContentChild(TemplateRef, { read: TemplateRef, static: false }) itemTemplateQuery: TemplateRef<ItemContext<T>>;

  fallbackItemTemplate: TemplateRef<ItemContext<T>>;

  @Input()
  get items() {
    return this._items;
  }

  set items(value: T[] | ObservableArray<T>) {
    this._items = value;
    let needDiffer = true;
    if (value instanceof ObservableArray) {
      needDiffer = false;
    }
    if (needDiffer && !this._differ && isListLikeIterable(value)) {
      this._differ = this._iterableDiffers.find(this._items).create((_index, item) => {
        return item;
      });
    }

    this.templatedItemsView.items = this._items;
  }

  /**
   * @deprecated
   */
  constructor(_elementRef: ElementRef);
  /**
   * @deprecated
   */
  constructor(_elementRef: ElementRef, _iterableDiffers: IterableDiffers, _changeDetectorRef: ChangeDetectorRef);
  /**
   * @deprecated
   */
  constructor(_elementRef: ElementRef, _iterableDiffers: IterableDiffers, _ngZone: NgZone);
  constructor();
  // this elementRef is only here for backwards compatibility reasons
  constructor(_elementRef?: ElementRef) {
    if (_elementRef) {
      this.templatedItemsView = _elementRef.nativeElement;
    }
  }

  ngAfterContentInit() {
    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.listViewLog('TemplatedItemsView.ngAfterContentInit()');
    }

    this.setItemTemplates();
  }

  ngOnDestroy() {
    this.templatedItemsView = null;

    if (this._templateMap) {
      this._templateMap.clear();
    }
  }

  private setItemTemplates() {
    // The itemTemplateQuery may be changed after list items are added that contain <template> inside,
    // so cache and use only the original template to avoid errors.
    this.fallbackItemTemplate = this.itemTemplateQuery;
    if (this.fallbackItemTemplate && !this._templateMap?.has('default')) {
      // apparently you can create a Core ListView without a template...
      // we also add a fallback default for when the user sets multiple templates but no templateSelector
      this.registerTemplate('default', this.fallbackItemTemplate);
    }

    if (this._templateMap) {
      // sometimes templates are registered before loader is ready, so we update here
      this._templateMap.forEach((t) => (t.location = this.loader));
      if (NativeScriptDebug.isLogEnabled()) {
        NativeScriptDebug.listViewLog('Setting templates');
      }

      const templates: KeyedTemplate[] = [];
      this._templateMap.forEach((value, key) => {
        templates.push({
          createView: () => null, // we'll handle creation later, otherwise core will create an invalid template
          key,
        });
      });
      this.templatedItemsView.itemTemplates = templates;
    }
  }

  public registerTemplate(key: string, template: TemplateRef<ItemContext<T>>) {
    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.listViewLog(`registerTemplate for key: ${key}, ${this.loader}`);
    }

    if (!this._templateMap) {
      this._templateMap = new Map<string, NsTemplatedItem<T>>();
    }

    this._templateMap.set(key, new NsTemplatedItem<T>(template, this.loader, (v) => this._viewToTemplate.set(v, key)));
  }

  @HostListener('itemLoading', ['$event'])
  @profile
  public onItemLoading(args: ItemEventData) {
    if (!this._templateMap) {
      return;
    }

    const index = args.index;
    const lview: ListView = <ListView>args.object;
    const items = lview.items;
    const currentItem = 'getItem' in items && typeof items.getItem === 'function' ? items.getItem(index) : items[index];

    let template: NsTemplatedItem<T>;

    if (args.view) {
      if (NativeScriptDebug.isLogEnabled()) {
        NativeScriptDebug.listViewLog(`onItemLoading: ${index} - Reusing existing view`);
      }

      let templateKey = this._viewToTemplate.get(args.view);
      if (!templateKey && args.view instanceof LayoutBase && args.view.getChildrenCount() > 0) {
        templateKey = this._viewToTemplate.get(args.view.getChildAt(0));
      }
      if (!templateKey) {
        // this template was not created by us
        if (NativeScriptDebug.isLogEnabled()) {
          NativeScriptDebug.listViewError(`ViewReference not found for item ${index}. View recycling is not working`);
        }
        return;
      }
      template = this._templateMap.get(templateKey);
      template.update(args.view, { index, data: currentItem });
    } else {
      // this should never enter if it creates the view
      const templateKey = typeof lview.itemTemplateSelector === 'function' ? lview.itemTemplateSelector(currentItem, index, items) : 'default';
      template = this._templateMap.get(templateKey);
      if (!template) {
        if (NativeScriptDebug.isLogEnabled()) {
          NativeScriptDebug.listViewError(`Template for key '${templateKey}' not found.`);
        }
        return;
      }
      args.view = template.create({ index, data: currentItem });
    }
    this.setupViewRef(template.getEmbeddedViewRef(args.view), currentItem, index, args.view);

    template.attach(args.view);
    this._changeDetectorRef.detectChanges();
  }

  public setupViewRef(viewRef: EmbeddedViewRef<ItemContext<T>>, data: T, index: number, nativeElement: View): void {
    const context = viewRef.context;
    this.setupItemView.next({ view: viewRef, nativeElement, data: data, index: index, context: context });
  }

  ngDoCheck() {
    if (this._differ) {
      if (NativeScriptDebug.isLogEnabled()) {
        NativeScriptDebug.listViewLog('ngDoCheck() - execute differ');
      }

      const changes = this._differ.diff(this._items as T[]);
      if (changes) {
        if (NativeScriptDebug.isLogEnabled()) {
          NativeScriptDebug.listViewLog('ngDoCheck() - refresh');
        }

        this.templatedItemsView.refresh();
      }
    }
  }
}

export type RootLocator = (nodes: Array<unknown>, nestLevel: number) => View;

export function getItemViewRoot(viewRef: EmbeddedViewRef<unknown>, rootLocator: RootLocator = extractSingleViewRecursive): View {
  const rootView = rootLocator(viewRef.rootNodes, 0);
  return rootView;
}

// eslint-disable-next-line @angular-eslint/directive-selector
@Directive({ selector: '[nsTemplateKey],[nsTemplateKeys]' })
export class TemplateKeyDirective<T> {
  constructor(private templateRef: TemplateRef<T>, @Host() @Inject(TEMPLATED_ITEMS_COMPONENT) private comp: TemplatedItemsHost<T>) {}

  @Input()
  set nsTemplateKey(value: string) {
    if (this.comp && this.templateRef) {
      this.comp.registerTemplate(value, this.templateRef);
    }
  }
  @Input()
  set nsTemplateKeys(values: string[]) {
    // single template with multiple keys
    if (this.comp && this.templateRef && values) {
      values.forEach((value) => this.comp.registerTemplate(value, this.templateRef));
    }
  }
}
