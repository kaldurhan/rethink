let filter = (_) => true;
export default function log(topic, ...args) {
    if (filter(topic))
        console.log(new Date(), topic, ...args);
}
export function setFilter(newFilter) {
    filter = newFilter;
}
