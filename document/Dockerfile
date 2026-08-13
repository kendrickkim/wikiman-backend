FROM ubuntu:24.04
USER root

RUN echo "#!/bin/bash" >> /bin/start_service.sh && \
    echo "" >> /bin/start_service.sh && \
    echo "service ssh start" >> /bin/start_service.sh && \
    echo "" >> /bin/start_service.sh && \
    echo "/bin/bash" >> /bin/start_service.sh && \
    chmod +x /bin/start_service.sh

RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y adduser vim openssh-server && \
    apt-get install -y curl \
    apt-get install -y build-essential \
    mkdir /www && \
    mkdir /www/default

WORKDIR /root

CMD ["/bin/bash", "/bin/start_service.sh"]