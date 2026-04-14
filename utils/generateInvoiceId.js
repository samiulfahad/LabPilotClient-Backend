const generateInvoiceId = () => {
  const pick = (pool, count) => {
    const arr = pool.split("");
    let out = "";
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * arr.length);
      out += arr.splice(idx, 1)[0];
    }
    return out;
  };
  return pick("ABCDEFGHIJKLMNPQRSTUVWXYZ", 3) + pick("123456789", 4);
};

export default generateInvoiceId
