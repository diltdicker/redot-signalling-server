let sample = [ 'W3j4r9nX', 'k8fT1o0J', 'B2k9f8zY', 'HjA7r4p3', 'nO5tQ8mP', 'gW4v3l7z', 'D7g0A9eX', 'vJ3h5K1o', 'K9cV2zR7', 'X8j6mQzV' ]

sample.map((w) => w.toUpperCase()).forEach((w) => {
    console.log('foreach');
    setImmediate(() => {
        console.log(w.slice(0,3));
    });
});
