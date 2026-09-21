// scratch: catalog products (correct path) (delete me after)
const cat = await (await fetch('https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/catalogs_products_v1.json')).json();
const pc = cat.paths?.['/v1/catalogs/products']?.post;
console.log('summary:', pc?.summary);
const ref = pc?.requestBody?.content?.['application/json']?.schema?.$ref;
console.log('body ref:', ref);
const name = ref && ref.split('/').pop();
const s = name && cat.components.schemas[name];
console.log(JSON.stringify(s, null, 2).slice(0, 2000));
