/* eslint-disable react/prefer-es6-class */
/* eslint-disable prefer-promise-reject-errors */

import React from 'react';
import createReactClass from 'create-react-class';
import unsafeLifecyclesPolyfill from 'rc-util/lib/unsafeLifecyclesPolyfill';
import AsyncValidator from 'async-validator';
import warning from 'warning';
import get from 'lodash/get';
import set from 'lodash/set';
import eq from 'lodash/eq';
import createFieldsStore from './createFieldsStore';
import {
  argumentContainer,
  identity,
  normalizeValidateRules,
  getValidateTriggers,
  getValueFromEvent,
  hasRules,
  getParams,
  isEmptyObject,
  flattenArray,
} from './utils';

const DEFAULT_TRIGGER = 'onChange';

function createBaseForm(option = {}, mixins = []) {
  const {
    validateMessages,
    onFieldsChange,
    onValuesChange,
    mapProps = identity,
    mapPropsToFields,
    fieldNameProp,
    fieldMetaProp,
    fieldDataProp,
    formPropName = 'form',
    name: formName,
    // @deprecated
    withRef,
  } = option;

  return function decorate(WrappedComponent) {
    const Form = createReactClass({
      mixins,

      // 这个相当于class组件的constructor
      getInitialState() {
        // 如果存在用户实现的mapPropsToFields，那就好办了，直接获取成型的fields
        // 这里我们也明白了为什么直接在mapPropsToFields里用Form.createFormField({value:xxx})了
        const fields = mapPropsToFields && mapPropsToFields(this.props);
        this.fieldsStore = createFieldsStore(fields || {});

        this.instances = {};
        this.cachedBind = {};
        // 当一个组件在被卸载（component为null）时，将可能被清理掉的Field的meta数据缓存一下
        // 因为如果是setField触发的组件更新，这些meta数据其实还要通过recover拿回来的（出于性能优化的目的）
        this.clearedFieldMetaCache = {};

        this.renderFields = {};
        // 判断dom中当前field是否存在
        this.domFields = {};

        // HACK: https://github.com/ant-design/ant-design/issues/6406
        [
          'getFieldsValue',
          'getFieldValue',
          'setFieldsInitialValue',
          'getFieldsError',
          'getFieldError',
          'isFieldValidating',
          'isFieldsValidating',
          'isFieldsTouched',
          'isFieldTouched',
        ].forEach(key => {
          this[key] = (...args) => {
            if (process.env.NODE_ENV !== 'production') {
              warning(
                false,
                'you should not use `ref` on enhanced form, please use `wrappedComponentRef`. ' +
                  'See: https://github.com/react-component/form#note-use-wrappedcomponentref-instead-of-withref-after-rc-form140',
              );
            }
            return this.fieldsStore[key](...args);
          };
        });

        return {
          submitting: false,
        };
      },

      componentDidMount() {
        this.cleanUpUselessFields();
      },

      componentWillReceiveProps(nextProps) {
        if (mapPropsToFields) {
          this.fieldsStore.updateFields(mapPropsToFields(nextProps));
        }
      },

      componentDidUpdate() {
        this.cleanUpUselessFields();
      },

      onCollectCommon(name, action, args) {
        const fieldMeta = this.fieldsStore.getFieldMeta(name);
        if (fieldMeta[action]) {
          fieldMeta[action](...args);
        } else if (fieldMeta.originalProps && fieldMeta.originalProps[action]) {
          fieldMeta.originalProps[action](...args);
        }
        // 如果用户自行配置了getValueFromEvent，就使用用户配置的
        const value = fieldMeta.getValueFromEvent
          ? fieldMeta.getValueFromEvent(...args)
          // 否则用默认的
          : getValueFromEvent(...args);
        // TODO onValueChange在这里就触发了，可以发现他是同步的
        if (onValuesChange && value !== this.fieldsStore.getFieldValue(name)) {
          const valuesAll = this.fieldsStore.getAllValues();
          const valuesAllSet = {};
          valuesAll[name] = value;
          Object.keys(valuesAll).forEach(key =>
            set(valuesAllSet, key, valuesAll[key]),
          );
          onValuesChange(
            {
              [formPropName]: this.getForm(),
              ...this.props,
            },
            set({}, name, value),
            valuesAllSet,
          );
        }
        const field = this.fieldsStore.getField(name);
        return { name, field: { ...field, value, touched: true }, fieldMeta };
      },

      // 收集数据
      onCollect(name_, action, ...args) {
        // 公共的收集方法
        const { name, field, fieldMeta } = this.onCollectCommon(
          name_,
          action,
          args,
        );
        const { validate } = fieldMeta;

        // 将meta中具有rules的fields设置为dirty，也就是数据更新了，但还未校验
        this.fieldsStore.setFieldsAsDirty();

        const newField = {
          ...field,
          dirty: hasRules(validate),
        };
        this.setFields({
          [name]: newField,
        });
      },

      // 收集数据并校验
      onCollectValidate(name_, action, ...args) {
        const { field, fieldMeta } = this.onCollectCommon(name_, action, args);
        const newField = {
          ...field,
          dirty: true,
        };

        this.fieldsStore.setFieldsAsDirty();

        this.validateFieldsInternal([newField], {
          action,
          options: {
            firstFields: !!fieldMeta.validateFirst,
          },
        });
      },

      /**
       * 辅助函数，用于获取自动被bind this到Form的缓存函数
       * @param name
       * @param action
       * @param fn
       * @return {{new(...args: any[]): any} | ((...args: any[]) => any) | OmitThisParameter<*> | * | {new(...args: *[]): any} | ((...args: *[]) => any)}
       */
      getCacheBind(name, action, fn) {
        if (!this.cachedBind[name]) {
          this.cachedBind[name] = {};
        }
        const cache = this.cachedBind[name];
        if (!cache[action] || cache[action].oriFn !== fn) {
          cache[action] = {
            fn: fn.bind(this, name, action),
            oriFn: fn,
          };
        }
        return cache[action].fn;
      },

      // 用来将表单字段和store进行双向绑定
      // 实际上起到了类似HOC的效果
      // 不过由于传入的是jsx组件，最后也要直接获得jsx
      // 这里就没有返回新的class了，而是直接克隆，
      // 这样可以保证原来挂在传入的jsx的props和attribute不受影响
      getFieldDecorator(name, fieldOption) {
        const props = this.getFieldProps(name, fieldOption);
        return fieldElem => {
          // We should put field in record if it is rendered
          // 由于getFieldDecorator是写在render函数里的
          // 也就是在render阶段被调用的，意味着这个组件肯定要被渲染了
          // 所以将renderFields中对应的当前表单字段名对应的标记设置为true
          this.renderFields[name] = true;
          // 获得当前表单字段名对应的元信息（如果有）
          const fieldMeta = this.fieldsStore.getFieldMeta(name);
          // 直接读取到jsx的属性，接下来会存给fieldMeta对象
          const originalProps = fieldElem.props;
          if (process.env.NODE_ENV !== 'production') {
            const valuePropName = fieldMeta.valuePropName;
            warning(
              !(valuePropName in originalProps),
              `\`getFieldDecorator\` will override \`${valuePropName}\`, ` +
                `so please don't set \`${valuePropName}\` directly ` +
                `and use \`setFieldsValue\` to set it.`,
            );
            const defaultValuePropName = `default${valuePropName[0].toUpperCase()}${valuePropName.slice(
              1,
            )}`;
            warning(
              !(defaultValuePropName in originalProps),
              `\`${defaultValuePropName}\` is invalid ` +
                `for \`getFieldDecorator\` will set \`${valuePropName}\`,` +
                ` please use \`option.initialValue\` instead.`,
            );
          }
          // 更新元信息，由于是引用，这里实际有副作用，直接修改了fieldsMeta对象
          fieldMeta.originalProps = originalProps;
          fieldMeta.ref = fieldElem.ref;
          return React.cloneElement(fieldElem, {
            ...props,
            ...this.fieldsStore.getFieldValuePropValue(fieldMeta),
          });
        };
      },

      /**
       * 根据传入的jsx组件和用户选项和构建Props
       * @param name
       * @param usersFieldOption
       * @return {{ref: *}}
       */
      getFieldProps(name, usersFieldOption = {}) {
        if (!name) {
          throw new Error('Must call `getFieldProps` with valid name string!');
        }
        if (process.env.NODE_ENV !== 'production') {
          warning(
            this.fieldsStore.isValidNestedFieldName(name),
            `One field name cannot be part of another, e.g. \`a\` and \`a.b\`. Check field: ${name}`,
          );
          warning(
            !('exclusive' in usersFieldOption),
            '`option.exclusive` of `getFieldProps`|`getFieldDecorator` had been remove.',
          );
        }

        // 清空掉被卸载的表单组件的缓存
        delete this.clearedFieldMetaCache[name];

        // 获得用户传进来的各种选项
        const fieldOption = {
          name,
          trigger: DEFAULT_TRIGGER,
          valuePropName: 'value',
          validate: [],
          ...usersFieldOption,
        };

        // trigger: 什么函数被调用时，触发表单数据收集/更新
        // validateTrigger 什么函数被调用时，触发校验
        const {
          rules,
          trigger,
          validateTrigger = trigger,
          validate,
        } = fieldOption;

        // 获得field的元信息（没有就创建一个）
        const fieldMeta = this.fieldsStore.getFieldMeta(name);
        // 配置meta的init值
        if ('initialValue' in fieldOption) {
          fieldMeta.initialValue = fieldOption.initialValue;
        }


        const inputProps = {
          // 获取field初始值，创建传给ref的函数（兼容老的react，其实现在不提倡了）
          ...this.fieldsStore.getFieldValuePropValue(fieldOption),
          ref: this.getCacheBind(name, `${name}__ref`, this.saveRef),
        };
        if (fieldNameProp) {
          inputProps[fieldNameProp] = formName ? `${formName}_${name}` : name;
        }

        // 校验过程，不重要，跳过
        const validateRules = normalizeValidateRules(
          validate,
          rules,
          validateTrigger,
        );
        const validateTriggers = getValidateTriggers(validateRules);
        validateTriggers.forEach(action => {
          if (inputProps[action]) return;
          inputProps[action] = this.getCacheBind(
            name,
            action,
            this.onCollectValidate,
          );
        });

        // make sure that the value will be collect
        if (trigger && validateTriggers.indexOf(trigger) === -1) {
          inputProps[trigger] = this.getCacheBind(
            name,
            trigger,
            this.onCollect,
          );
        }

        // 配置校验器
        const meta = {
          ...fieldMeta,
          ...fieldOption,
          validate: validateRules,
        };
        // 设置meta值
        this.fieldsStore.setFieldMeta(name, meta);
        // 如果用户配了fieldDataProp，就把field整个数据设置到这个字段上返回
        if (fieldMetaProp) {
          inputProps[fieldMetaProp] = meta;
        }

        // 如果用户配了fieldDataProp，就把field整个数据设置到这个字段上返回
        if (fieldDataProp) {
          inputProps[fieldDataProp] = this.fieldsStore.getField(name);
        }

        // This field is rendered, record it
        // 标志当前的field被渲染了
        this.renderFields[name] = true;

        return inputProps;
      },

      getFieldInstance(name) {
        return this.instances[name];
      },

      getRules(fieldMeta, action) {
        const actionRules = fieldMeta.validate
          .filter(item => {
            return !action || item.trigger.indexOf(action) >= 0;
          })
          .map(item => item.rules);
        return flattenArray(actionRules);
      },


      /**
       * 实际上触发组件刷新的方法，可以看到最后用了forceupdate，跳过shoudlComponentUpdate
       * 直接刷新组件，因为此时store里的值都已经更新了，且这些value（作为props）都被接管了
       * 更新会直接生效
       * @param maybeNestedFields
       * @param callback
       */
      setFields(maybeNestedFields, callback) {
        // 手动清除可能嵌套的fields
        const fields = this.fieldsStore.flattenRegisteredFields(
          maybeNestedFields,
        );
        // store更新fields对应数据
        this.fieldsStore.setFields(fields);
        // TODO： 用户提供的钩子方法，这个方法在onValueChange之后触发
        if (onFieldsChange) {
          // 获得变更了的fields数据
          const changedFields = Object.keys(fields).reduce(
            (acc, name) => set(acc, name, this.fieldsStore.getField(name)),
            {},
          );
          // 触发用户的钩子
          onFieldsChange(
            {
              [formPropName]: this.getForm(),
              ...this.props,
            },
            changedFields,
            this.fieldsStore.getNestedAllFields(),
          );
        }
        // 强制刷新
        this.forceUpdate(callback);
      },

      setFieldsValue(changedValues, callback) {
        const { fieldsMeta } = this.fieldsStore;
        const values = this.fieldsStore.flattenRegisteredFields(changedValues);
        const newFields = Object.keys(values).reduce((acc, name) => {
          const isRegistered = fieldsMeta[name];
          if (process.env.NODE_ENV !== 'production') {
            warning(
              isRegistered,
              'Cannot use `setFieldsValue` until ' +
                'you use `getFieldDecorator` or `getFieldProps` to register it.',
            );
          }
          if (isRegistered) {
            const value = values[name];
            acc[name] = {
              value,
            };
          }
          return acc;
        }, {});
        this.setFields(newFields, callback);
        if (onValuesChange) {
          const allValues = this.fieldsStore.getAllValues();
          onValuesChange(
            {
              [formPropName]: this.getForm(),
              ...this.props,
            },
            changedValues,
            allValues,
          );
        }
      },

      /**
       * 指定字段组件的 ref 引用为 BaseForm 组件实例
       * @param name
       * @param _
       * @param component
       */
      saveRef(name, _, component) {
        if (!component) {
          const fieldMeta = this.fieldsStore.getFieldMeta(name);
          if (!fieldMeta.preserve) {
            // after destroy, delete data
            this.clearedFieldMetaCache[name] = {
              field: this.fieldsStore.getField(name),
              meta: fieldMeta,
            };
            this.clearField(name);
          }
          delete this.domFields[name];
          return;
        }
        // 由于调用了saveRef，说明该组件被渲染，domField设置为true
        this.domFields[name] = true;
        // 将组件卸载时的缓存的meta复原到store
        this.recoverClearedField(name);
        // 从store里拿到该拿的meta
        const fieldMeta = this.fieldsStore.getFieldMeta(name);
        if (fieldMeta) {
          // 调用执行挂在组件上的ref函数，来干用户期待做的事情，把该filed实例暴露出去
          const ref = fieldMeta.ref;
          if (ref) {
            if (typeof ref === 'string') {
              throw new Error(`can not set ref string for ${name}`);
            } else if (typeof ref === 'function') {
              ref(component);
            } else if (Object.prototype.hasOwnProperty.call(ref, 'current')) {
              ref.current = component;
            }
          }
        }
        this.instances[name] = component;
      },

      cleanUpUselessFields() {
        const fieldList = this.fieldsStore.getAllFieldsName();
        const removedList = fieldList.filter(field => {
          const fieldMeta = this.fieldsStore.getFieldMeta(field);
          return (
            !this.renderFields[field] &&
            !this.domFields[field] &&
            !fieldMeta.preserve
          );
        });
        if (removedList.length) {
          removedList.forEach(this.clearField);
        }
        this.renderFields = {};
      },

      clearField(name) {
        this.fieldsStore.clearField(name);
        delete this.instances[name];
        delete this.cachedBind[name];
      },

      resetFields(ns) {
        const newFields = this.fieldsStore.resetFields(ns);
        if (Object.keys(newFields).length > 0) {
          this.setFields(newFields);
        }
        if (ns) {
          const names = Array.isArray(ns) ? ns : [ns];
          names.forEach(name => delete this.clearedFieldMetaCache[name]);
        } else {
          this.clearedFieldMetaCache = {};
        }
      },

      recoverClearedField(name) {
        if (this.clearedFieldMetaCache[name]) {
          this.fieldsStore.setFields({
            [name]: this.clearedFieldMetaCache[name].field,
          });
          this.fieldsStore.setFieldMeta(
            name,
            this.clearedFieldMetaCache[name].meta,
          );
          delete this.clearedFieldMetaCache[name];
        }
      },

      /**
       * 创建 AsyncValidator 的实例
       * 由 AsyncValidator 根据组件的配置规则进行校验
       * 并将最终的校验结果和表单数据更新到 fieldStore。
       * @param fields
       * @param fieldNames
       * @param action
       * @param options
       * @param callback
       */
      validateFieldsInternal(
        fields,
        { fieldNames, action, options = {} },
        callback,
      ) {
        const allRules = {};
        const allValues = {};
        const allFields = {};
        const alreadyErrors = {};
        fields.forEach(field => {
          const name = field.name;
          if (options.force !== true && field.dirty === false) {
            if (field.errors) {
              set(alreadyErrors, name, { errors: field.errors });
            }
            return;
          }
          const fieldMeta = this.fieldsStore.getFieldMeta(name);
          const newField = {
            ...field,
          };
          newField.errors = undefined;
          newField.validating = true;
          newField.dirty = true;
          allRules[name] = this.getRules(fieldMeta, action);
          allValues[name] = newField.value;
          allFields[name] = newField;
        });
        this.setFields(allFields);
        // in case normalize
        Object.keys(allValues).forEach(f => {
          allValues[f] = this.fieldsStore.getFieldValue(f);
        });
        if (callback && isEmptyObject(allFields)) {
          callback(
            isEmptyObject(alreadyErrors) ? null : alreadyErrors,
            this.fieldsStore.getFieldsValue(fieldNames),
          );
          return;
        }
        const validator = new AsyncValidator(allRules);
        if (validateMessages) {
          validator.messages(validateMessages);
        }
        validator.validate(allValues, options, errors => {
          const errorsGroup = {
            ...alreadyErrors,
          };
          if (errors && errors.length) {
            errors.forEach(e => {
              const errorFieldName = e.field;
              let fieldName = errorFieldName;

              // Handle using array validation rule.
              // ref: https://github.com/ant-design/ant-design/issues/14275
              Object.keys(allRules).some(ruleFieldName => {
                const rules = allRules[ruleFieldName] || [];

                // Exist if match rule
                if (ruleFieldName === errorFieldName) {
                  fieldName = ruleFieldName;
                  return true;
                }

                // Skip if not match array type
                if (
                  rules.every(({ type }) => type !== 'array') ||
                  errorFieldName.indexOf(`${ruleFieldName}.`) !== 0
                ) {
                  return false;
                }

                // Exist if match the field name
                const restPath = errorFieldName.slice(ruleFieldName.length + 1);
                if (/^\d+$/.test(restPath)) {
                  fieldName = ruleFieldName;
                  return true;
                }

                return false;
              });

              const field = get(errorsGroup, fieldName);
              if (typeof field !== 'object' || Array.isArray(field)) {
                set(errorsGroup, fieldName, { errors: [] });
              }
              const fieldErrors = get(errorsGroup, fieldName.concat('.errors'));
              fieldErrors.push(e);
            });
          }
          const expired = [];
          const nowAllFields = {};
          Object.keys(allRules).forEach(name => {
            const fieldErrors = get(errorsGroup, name);
            const nowField = this.fieldsStore.getField(name);
            // avoid concurrency problems
            if (!eq(nowField.value, allValues[name])) {
              expired.push({
                name,
              });
            } else {
              nowField.errors = fieldErrors && fieldErrors.errors;
              nowField.value = allValues[name];
              nowField.validating = false;
              nowField.dirty = false;
              nowAllFields[name] = nowField;
            }
          });
          this.setFields(nowAllFields);
          if (callback) {
            if (expired.length) {
              expired.forEach(({ name }) => {
                const fieldErrors = [
                  {
                    message: `${name} need to revalidate`,
                    field: name,
                  },
                ];
                set(errorsGroup, name, {
                  expired: true,
                  errors: fieldErrors,
                });
              });
            }

            callback(
              isEmptyObject(errorsGroup) ? null : errorsGroup,
              this.fieldsStore.getFieldsValue(fieldNames),
            );
          }
        });
      },

      validateFields(ns, opt, cb) {
        const pending = new Promise((resolve, reject) => {
          const { names, options } = getParams(ns, opt, cb);
          let { callback } = getParams(ns, opt, cb);
          if (!callback || typeof callback === 'function') {
            const oldCb = callback;
            callback = (errors, values) => {
              if (oldCb) {
                oldCb(errors, values);
              }
              if (errors) {
                reject({ errors, values });
              } else {
                resolve(values);
              }
            };
          }
          const fieldNames = names
            ? this.fieldsStore.getValidFieldsFullName(names)
            : this.fieldsStore.getValidFieldsName();
          const fields = fieldNames
            .filter(name => {
              const fieldMeta = this.fieldsStore.getFieldMeta(name);
              return hasRules(fieldMeta.validate);
            })
            .map(name => {
              const field = this.fieldsStore.getField(name);
              field.value = this.fieldsStore.getFieldValue(name);
              return field;
            });
          if (!fields.length) {
            callback(null, this.fieldsStore.getFieldsValue(fieldNames));
            return;
          }
          if (!('firstFields' in options)) {
            options.firstFields = fieldNames.filter(name => {
              const fieldMeta = this.fieldsStore.getFieldMeta(name);
              return !!fieldMeta.validateFirst;
            });
          }
          this.validateFieldsInternal(
            fields,
            {
              fieldNames,
              options,
            },
            callback,
          );
        });
        pending.catch(e => {
          // eslint-disable-next-line no-console
          if (console.error && process.env.NODE_ENV !== 'production') {
            // eslint-disable-next-line no-console
            console.error(e);
          }
          return e;
        });
        return pending;
      },

      isSubmitting() {
        if (
          process.env.NODE_ENV !== 'production' &&
          process.env.NODE_ENV !== 'test'
        ) {
          warning(
            false,
            '`isSubmitting` is deprecated. ' +
              "Actually, it's more convenient to handle submitting status by yourself.",
          );
        }
        return this.state.submitting;
      },

      submit(callback) {
        if (
          process.env.NODE_ENV !== 'production' &&
          process.env.NODE_ENV !== 'test'
        ) {
          warning(
            false,
            '`submit` is deprecated. ' +
              "Actually, it's more convenient to handle submitting status by yourself.",
          );
        }
        const fn = () => {
          this.setState({
            submitting: false,
          });
        };
        this.setState({
          submitting: true,
        });
        callback(fn);
      },

      render() {
        const { wrappedComponentRef, ...restProps } = this.props; // eslint-disable-line
        const formProps = {
          [formPropName]: this.getForm(),
        };
        if (withRef) {
          if (
            process.env.NODE_ENV !== 'production' &&
            process.env.NODE_ENV !== 'test'
          ) {
            warning(
              false,
              '`withRef` is deprecated, please use `wrappedComponentRef` instead. ' +
                'See: https://github.com/react-component/form#note-use-wrappedcomponentref-instead-of-withref-after-rc-form140',
            );
          }
          formProps.ref = 'wrappedComponent';
        } else if (wrappedComponentRef) {
          formProps.ref = wrappedComponentRef;
        }
        const props = mapProps.call(this, {
          ...formProps,
          ...restProps,
        });
        return <WrappedComponent {...props} />;
      },
    });

    return argumentContainer(unsafeLifecyclesPolyfill(Form), WrappedComponent);
  };
}

export default createBaseForm;
